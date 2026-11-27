# png-squeeze-01

make.fun entry for **png-squeeze-01-run-20261127** — squeeze 1280×720 screenshots into the smallest lossless PNG.

## How it squeezes

`main.ts` (Node 22, no dependencies beyond Node builtins) reads each
`/input/<id>/image.png`, decodes it to RGBA, and writes a smaller lossless PNG
to `/output/<id>/image.png`:

1. **Candidate colour forms** — palette (≤256 colours, ordered by count or by
   luminance, with tRNS when the image has transparent pixels) and channel
   forms (grey / grey+alpha / RGB / RGBA, with a tRNS colour key when all
   transparent pixels share one colour).
2. **Filter screening** — every form is tried with fixed filters 0–4 plus
   adaptive per-row choices (minimum signed-sum, fewest distinct byte pairs,
   and a brute-force row compressor at zlib level 4 with the previous output
   as dictionary). Candidates are ranked by zlib level 6 size.
3. **Final deflate** — the winning filtered bytes are re-compressed with the
   best of four zlib level-9 variants: plain, memLevel 8 + filtered strategy,
   and two SYNC_FLUSH split streams (128 KiB / 256 KiB chunks), which reset
   the match window at fixed offsets.

Deterministic: no clock, no randomness, no network. The work budget is the
candidate list, not time.

## Local results (practice set, kit checker)

| instance | theme | bytes | points |
|----------|-------|------:|-------:|
| i001 | flat | 12,329 | 726.6 |
| i002 | rich | 51,345 | 711.7 |
| i003 | alpha | 105,300 | 682.7 |
| i004 | grey | 105,479 | 697.1 |
| i005 | flat | 16,356 | 749.3 |
| i006 | rich | 178,606 | 690.7 |
| i007 | alpha | 60,626 | 704.6 |
| i008 | grey | 24,478 | 724.6 |
| **mean** | | | **710.9** |

Total score 710,899 / 1,000,000. Wall time ~13.5 s for all 8 instances on the
dev VM (limit 60 s). All 8 outputs verified exact and byte-identical across
repeated runs.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
