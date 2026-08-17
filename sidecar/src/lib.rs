//! Data-exact primitives for the editor's Typst line-break port.
//!
//! Everything here mirrors `crates/typst-layout/src/inline/` at Typst source
//! commit 951788cc614cd805d5d786e17bbf93796df73d10. Dependency versions follow
//! the reconstructed typst.ts 0.7.0 outer graph and are checked against crate
//! paths embedded in the distributed compiler; notably, that outer graph
//! selects hypher 0.1.6 rather than the source checkout's nested-lock 0.1.5.
//! The ICU blob and segmenter construction still come from that Typst source.
//! The TypeScript port supplies the algorithm; this module supplies the three
//! data sources that cannot be faithfully reimplemented: UAX #14
//! segmentation, hyphenation patterns, and OpenType shaping.

use std::sync::LazyLock;

use icu_properties::{maps::CodePointMapData, LineBreak};
use icu_provider::AsDeserializingBufferProvider;
use icu_provider_adapters::fork::ForkByKeyProvider;
use icu_provider_blob::BlobDataProvider;
use icu_segmenter::LineSegmenter;
use rustybuzz::{BufferFlags, Direction, Face, Feature, Language, ShapePlan, UnicodeBuffer};
use wasm_bindgen::prelude::*;

/// The ICU blob data. Identical to linebreak.rs.
fn blob() -> BlobDataProvider {
    BlobDataProvider::try_new_from_static_blob(typst_assets::icu::ICU).unwrap()
}

/// The general line break segmenter. Identical to linebreak.rs.
static SEGMENTER: LazyLock<LineSegmenter> =
    LazyLock::new(|| LineSegmenter::try_new_lstm_with_buffer_provider(&blob()).unwrap());

/// The line break segmenter for Chinese/Japanese text. Identical to linebreak.rs.
static CJ_SEGMENTER: LazyLock<LineSegmenter> = LazyLock::new(|| {
    let cj_blob =
        BlobDataProvider::try_new_from_static_blob(typst_assets::icu::ICU_CJ_SEGMENT).unwrap();
    let cj_provider = ForkByKeyProvider::new(cj_blob, blob());
    LineSegmenter::try_new_lstm_with_buffer_provider(&cj_provider).unwrap()
});

/// The Unicode line break properties for each code point. Identical to linebreak.rs.
static LINEBREAK_DATA: LazyLock<CodePointMapData<LineBreak>> =
    LazyLock::new(|| icu_properties::maps::load_line_break(&blob().as_deserializing()).unwrap());

/// UAX #14 line break opportunities for `text`, as UTF-8 byte offsets.
/// This is exactly `SEGMENTER.segment_str(text)` from `breakpoints()`,
/// including the leading offset-0 opportunity that the algorithm skips.
#[wasm_bindgen]
pub fn segment(text: &str, cj: bool) -> Vec<u32> {
    let seg: &LineSegmenter = if cj { &CJ_SEGMENTER } else { &SEGMENTER };
    seg.segment_str(text).map(|i| i as u32).collect()
}

/// The ICU LineBreak property value for each codepoint of `text`, in order.
/// The TS port pairs this with the codepoints to evaluate the same
/// `lb.get(c)` matches as `breakpoints()`, `Breakpoint::trim`, and
/// `hyphenations()`.
#[wasm_bindgen]
pub fn lb_classes(text: &str) -> Vec<u8> {
    let lb = LINEBREAK_DATA.as_borrowed();
    text.chars().map(|c| lb.get(c).0).collect()
}

/// The LineBreak property constants the algorithm compares against, exported
/// from the actual icu_properties values so the TS side never transcribes
/// them by hand. Order: MandatoryBreak, CarriageReturn, LineFeed, NextLine,
/// Space, CombiningMark, Glue, WordJoiner, ZWJ.
#[wasm_bindgen]
pub fn lb_constants() -> Vec<u8> {
    vec![
        LineBreak::MandatoryBreak.0,
        LineBreak::CarriageReturn.0,
        LineBreak::LineFeed.0,
        LineBreak::NextLine.0,
        LineBreak::Space.0,
        LineBreak::CombiningMark.0,
        LineBreak::Glue.0,
        LineBreak::WordJoiner.0,
        LineBreak::ZWJ.0,
    ]
}

/// UAX #29 word boundaries (unicode-segmentation's `split_word_bounds`) as
/// cumulative UTF-8 byte offsets of segment ends. `breakpoints()` feeds each
/// segment between UAX #14 opportunities through this before hyphenating.
#[wasm_bindgen]
pub fn word_bounds(text: &str) -> Vec<u32> {
    use unicode_segmentation::UnicodeSegmentation;
    let mut out = Vec::new();
    let mut offset = 0u32;
    for seg in text.split_word_bounds() {
        offset += seg.len() as u32;
        out.push(offset);
    }
    out
}

/// Syllable boundaries for `word` per hypher, as cumulative UTF-8 byte
/// offsets (one entry per syllable, the last equals `word.len()`).
/// Mirrors the `hypher::hyphenate(word, lang)` loop in `hyphenations()`.
/// Empty result = unknown language (caller treats as no hyphenation).
#[wasm_bindgen]
pub fn hyphenate(word: &str, lang: &str) -> Vec<u32> {
    let Ok(bytes) = <[u8; 2]>::try_from(lang.as_bytes()) else {
        return Vec::new();
    };
    let Some(lang) = hypher::Lang::from_iso(bytes) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut offset = 0u32;
    for syllable in hypher::hyphenate(word, lang) {
        offset += syllable.len() as u32;
        out.push(offset);
    }
    out
}

/// A font store + shaper mirroring `shape_segment()`'s rustybuzz usage.
#[wasm_bindgen]
pub struct Shaper {
    fonts: Vec<(Vec<u8>, u32)>,
}

#[wasm_bindgen]
impl Shaper {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Shaper {
        Shaper { fonts: Vec::new() }
    }

    /// Register a font (raw OTF/TTF bytes + face index). Returns the font id
    /// to pass to `shape`, or -1 if the face fails to parse.
    pub fn add_font(&mut self, data: Vec<u8>, index: u32) -> i32 {
        if Face::from_slice(&data, index).is_none() {
            return -1;
        }
        self.fonts.push((data, index));
        (self.fonts.len() - 1) as i32
    }

    /// Units per em for a registered font. The TS side computes
    /// `x_advance_em = units / upem`, the same f64 division as
    /// `Font::to_em`.
    pub fn upem(&self, font: usize) -> u32 {
        let (data, index) = &self.fonts[font];
        Face::from_slice(data, *index).map_or(0, |f| f.units_per_em() as u32)
    }

    /// The glyph id for a single char (0 = not covered). Used by the TS
    /// mirror of the coverage / tofu checks and `ShapedText::hyphen`.
    pub fn glyph_index(&self, font: usize, c: u32) -> u32 {
        let (data, index) = &self.fonts[font];
        let Some(face) = Face::from_slice(data, *index) else {
            return 0;
        };
        let Some(c) = char::from_u32(c) else { return 0 };
        face.glyph_index(c).map_or(0, |g| g.0 as u32)
    }

    /// The font's OS/2 superscript height (ySuperscriptYSize) in em, or 0
    /// if the font provides no superscript metrics. Typst synthesizes
    /// superscripts (footnote markers) at this scale when the font has no
    /// working `sups` feature (FontMetrics::from_ttf → ScriptMetrics.height).
    pub fn superscript_height(&self, font: usize) -> f64 {
        let (data, index) = &self.fonts[font];
        let Some(face) = Face::from_slice(data, *index) else {
            return 0.0;
        };
        face.superscript_metrics()
            .map_or(0.0, |m| m.y_size as f64 / face.units_per_em() as f64)
    }

    /// The x-advance in font units for a glyph id.
    pub fn glyph_advance(&self, font: usize, glyph: u32) -> i32 {
        let (data, index) = &self.fonts[font];
        let Some(face) = Face::from_slice(data, *index) else {
            return 0;
        };
        face.glyph_hor_advance(rustybuzz::ttf_parser::GlyphId(glyph as u16))
            .map_or(0, |a| a as i32)
    }

    /// Shape `text` exactly as `shape_segment()` does: fill a UnicodeBuffer,
    /// set language and direction, guess segment properties, remove default
    /// ignorables, build a ShapePlan from the buffer's resolved properties,
    /// and shape.
    ///
    /// `features` is a comma-separated list in HarfBuzz feature syntax
    /// (empty for Typst's defaults). Returns a flat array of 5 values per
    /// glyph: [glyph_id, cluster (byte offset), x_advance (units),
    /// x_offset (units), unsafe_to_break (0|1)].
    pub fn shape(&self, font: usize, text: &str, rtl: bool, lang: &str, features: &str) -> Vec<i32> {
        let (data, index) = &self.fonts[font];
        let Some(face) = Face::from_slice(data, *index) else {
            return Vec::new();
        };

        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(text);
        if let Ok(language) = lang.parse::<Language>() {
            buffer.set_language(language);
        }
        buffer.set_direction(if rtl {
            Direction::RightToLeft
        } else {
            Direction::LeftToRight
        });
        buffer.guess_segment_properties();
        buffer.set_flags(BufferFlags::REMOVE_DEFAULT_IGNORABLES);

        let feature_list: Vec<Feature> = features
            .split(',')
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect();

        // Mirrors create_shape_plan: plan from the buffer's direction,
        // script, and language after guessing.
        let plan = ShapePlan::new(
            &face,
            buffer.direction(),
            Some(buffer.script()),
            buffer.language().as_ref(),
            &feature_list,
        );

        let glyphs = rustybuzz::shape_with_plan(&face, &plan, buffer);
        let infos = glyphs.glyph_infos();
        let pos = glyphs.glyph_positions();

        let mut out = Vec::with_capacity(infos.len() * 5);
        for (info, p) in infos.iter().zip(pos) {
            out.push(info.glyph_id as i32);
            out.push(info.cluster as i32);
            out.push(p.x_advance);
            out.push(p.x_offset);
            out.push(info.unsafe_to_break() as i32);
        }
        out
    }
}
