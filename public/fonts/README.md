# Bundled font notices

The font binaries in this directory are third-party works and keep their own
licenses. They are not covered by the license selected for Plass source code.

| Files | Bundled version | License notice |
| --- | --- | --- |
| `DejaVuSansMono.ttf` | DejaVu Fonts 2.37 | `licenses/DejaVu-LICENSE.txt` |
| `LibertinusSerif-*.otf` | Libertinus 7.051 | `licenses/Libertinus-OFL.txt` (SIL OFL 1.1) |
| `NewCM*.otf`, `NewCM*.woff2` | New Computer Modern 8.1.1 | `licenses/NewComputerModern-License.txt` (mixed GUST/GPLv3-or-later with font and distribution exceptions; see the notice for the exact files) |
| `STIXTwoText-*.otf` | STIX Two Text 2.02 | `licenses/STIXTwo-OFL.txt` (SIL OFL 1.1) |
| `texgyrepagella-*.otf` | TeX Gyre Pagella 2.501 | `licenses/TeX-Gyre-GUST-FONT-LICENSE.txt` |

Do not remove these notices when redistributing a production build. The build
verification step checks that all five notices are present in `dist/`.
