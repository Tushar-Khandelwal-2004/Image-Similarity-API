# Image Similarity API

An explainable TypeScript API that compares an original image with a suspect image and shows what changed.

## Table of Contents

- [Why we are building this](#why-we-are-building-this)
- [What we are building](#what-we-are-building)
- [Who it is for](#who-it-is-for)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [API reference](#api-reference)
- [Benchmarks](#benchmarks)
- [Getting started](#getting-started)
- [Deployment](#deployment)
- [Roadmap](#roadmap)
- [Known limitations](#known-limitations)
- [Credits and license](#credits-and-license)

## Why we are building this

Images get copied, edited, recompressed, and reposted. An exact hash catches only byte-for-byte reuse. Pixel comparison breaks when a legitimate filter, resize, or compression pass changes every pixel. Heavy AI-only tools can be slow and opaque: they may return a number without showing the evidence behind it.

This project combines fast exact and perceptual checks, semantic image embeddings, and a visible tamper map. The layered result gives a developer one API response that says how similar two images are, why the score moved, and where the suspect image differs. It grew out of lessons from my earlier project SecurePixel: a useful image verification tool needs both a trustworthy score and an explanation a person can inspect.

## What we are building

The service accepts `source` and `suspect` image uploads and returns:

- a similarity score from `0` to `1`;
- one of `identical`, `near_duplicate`, `tampered_match`, or `different`;
- exact, hash, CLIP, and pixel-layer evidence;
- changed-region bounding boxes in normalized suspect-image coordinates;
- a PNG heatmap overlay;
- timing information and a request ID.

Example response:

```json
{
  "similarity": 0.93,
  "verdict": "tampered_match",
  "layers": {
    "exact": false,
    "phashDistance": 6,
    "dhashDistance": 8,
    "hashScore": 0.89,
    "embeddingCosine": 0.91,
    "embeddingScore": 0.78,
    "pixelScore": 0.82,
    "changedFraction": 0.07
  },
  "regions": [{ "x": 120, "y": 80, "width": 140, "height": 90 }],
  "heatmapPngBase64": "...",
  "normalizedSize": { "width": 384, "height": 256 },
  "timingMs": { "total": 420, "ingest": 40, "hash": 15, "embed": 300, "tamper": 60 },
  "requestId": "..."
}
```

### Demo screenshots

> **Screenshot placeholder:** capture the comparison page after running the tampered preset and save it as `docs/images/demo-compare.png`.

![Comparison demo](docs/images/demo-compare.png)

> **Screenshot placeholder:** capture the API tab with a real JSON response and save it as `docs/images/demo-api.png`.

![API response tab](docs/images/demo-api.png)

## Who it is for

**Photographers and stock agencies.** They ask: “Is this submission the same image as an earlier file, even after a crop, filter, or recompression?” The layered response provides a quick similarity check and a visual explanation for review queues.

**Newsrooms and fact checkers.** They ask: “Was this image reused or edited before it reached us?” Hash and semantic evidence help find related copies while the heatmap highlights likely edits for human verification.

**Marketplaces and moderation teams.** They ask: “Is this listing image copied from another listing or altered in a suspicious region?” The API returns machine-readable scores and boxes that can feed an existing moderation workflow.

**Educators checking submitted images.** They ask: “Do these submissions appear to reuse the same source image?” The service gives a repeatable comparison without requiring a separate Python or computer-vision stack.

**Developers who want a similarity API.** They ask: “Can I call one endpoint and get both a score and evidence?” This repository provides a strict multipart contract, typed layers, a static demo, and a curl-friendly response.

## How it works

### System context

```mermaid
flowchart LR
  Client[Client or demo] ==> API[Fastify API]
  API ==> Layers[Exact hash embedding tamper layers]
  Layers ==> Response[Score verdict boxes heatmap]
  Response ==> Client
```

### Request lifecycle

```mermaid
flowchart LR
  Upload[Upload] ==> Validate[Validate bytes]
  Validate ==> Normalize[Normalize with Sharp]
  Normalize ==> Exact[Exact SHA check]
  Exact ==> Exit[Early identical response]
  Exact ==> Hashes[pHash and dHash]
  Hashes ==> Embed[CLIP embedding]
  Embed ==> Tamper[Tamper map]
  Tamper ==> Fuse[Fusion]
  Fuse ==> JSON[JSON response]
```

### Layer by layer

| Layer | Detects | Misses or can confuse | Typical cost |
| --- | --- | --- | --- |
| Exact SHA-256 | Byte-identical uploads | Any re-encoding or edit | Very low |
| pHash and dHash | Perceptual structure and local gradients | Large crops, rotations, heavy edits | Low |
| CLIP ViT-B/32 | Semantic similarity through filters and style changes | Fine-grained pixel edits and unusual content | Highest |
| Tamper map | Local changed regions and a visual overlay | Unaligned crops and rotations | Medium |

### Fusion

The hand-tuned defaults live in `src/layers/fuse.ts`:

```text
hashScore = 1 - average(phashDistance / 64, dhashDistance / 64)
embeddingScore = clamp((cosine - 0.6) / 0.4, 0, 1)
pixelScore = clamp(1 - changedFraction * 4, 0, 1)
similarity = 0.2 * hashScore + 0.5 * embeddingScore + 0.3 * pixelScore
```

If embeddings are unavailable, the embedding weight is redistributed proportionally across hash and pixel scores and the response includes `degraded: true`. Verdict rules are: exact matches are `identical`; similarity at least `0.9` with changed fraction under `0.02` is `near_duplicate`; similarity at least `0.55` with at least one region is `tampered_match`; everything else is `different`.

### Tamper map

```mermaid
flowchart LR
  Source[Source] ==> Resize[Resize to source size]
  Suspect[Suspect] ==> Resize
  Resize ==> Gray[Grayscale and blur]
  Gray ==> Diff[Absolute difference]
  Diff ==> Mask[Threshold dilate erode]
  Mask ==> Regions[Connected regions]
  Diff ==> Heatmap[Red alpha heatmap]
  Regions ==> Response[Boxes and response]
  Heatmap ==> Response
```

### Failure handling

```mermaid
flowchart LR
  Embed[Embedding inference] ==> Timeout{Within timeout?}
  Timeout ==>|yes| Fuse[Full fusion]
  Timeout ==> |no| Degraded[Hash plus pixel fusion]
  Degraded ==> Flag[degraded true]
  Fuse ==> Response[Response]
  Flag ==> Response
```

### Planned architecture

```mermaid
flowchart LR
  Gateway[Gateway] ==> Queue[Redis queue]
  Queue ==> Workers[Comparison workers]
  Workers ==> Cache[Embedding cache]
  Workers ==> Storage[Object storage]
  Workers ==> Geometry[Geometric alignment]
  Geometry ==> Result[Async result]
```

This is the planned design, not a built feature. The current service is single-process with an in-memory cache and synchronous HTTP comparison.

## Tech stack

| Choice | Reason |
| --- | --- |
| Node.js and TypeScript strict mode | Typed server code and one language across API, benchmark, and tooling |
| Fastify | Small, fast HTTP server with typed plugin support |
| `@fastify/multipart` | Explicit multipart upload handling and size limits |
| Sharp | Image validation, normalization, transforms, raw pixels, and PNG output |
| Transformers.js | Local CLIP ViT-B/32 inference without a Python service |
| Vitest | Fast unit and route tests |
| pnpm and tsx | Reproducible installs and direct TypeScript development scripts |
| Docker Debian slim | glibc-compatible ONNX runtime and reproducible deployment |

## API reference

### Health endpoints

```json
{ "ok": true, "modelReady": true }
```

- `GET /health` returns service and model state.
- `GET /health/live` is a lightweight process liveness check for a platform restart probe.
- `GET /health/ready` returns `200` only when CLIP is ready and `503` while it is warming up. Docker health checks and deployment smoke tests use this endpoint.

### `POST /v1/compare`

Send `multipart/form-data` with exactly two file fields named `source` and `suspect`. Accepted formats are JPEG, PNG, and WebP. Each upload is limited to 10 MB, Sharp is configured with a 40-million-pixel input limit, and normalization applies EXIF rotation, white flattening, sRGB conversion, metadata stripping, and a 512-pixel long-side limit.

```bash
curl -X POST http://localhost:3000/v1/compare \
  -F "source=@source.png" \
  -F "suspect=@suspect.png"
```

```ts
const form = new FormData();
form.append('source', sourceFile);
form.append('suspect', suspectFile);
const response = await fetch('http://localhost:3000/v1/compare', { method: 'POST', body: form });
const result = await response.json();
```

The response fields are `similarity`, `verdict`, `layers`, `regions`, `heatmapPngBase64`, `normalizedSize`, `timingMs`, and `requestId`. A degraded response additionally contains `degraded: true`. Region coordinates are in normalized suspect-image space.

### Errors

| Code | HTTP status | Meaning |
| --- | ---: | --- |
| `MISSING_FILE` | 400 | `source` or `suspect` is missing or duplicated |
| `FILE_TOO_LARGE` | 413 | An upload exceeds the 10 MB limit |
| `INVALID_IMAGE` | 400 | Bytes are not a readable JPEG, PNG, or WebP |
| `UNAUTHORIZED` | 401 | `API_KEY` is configured and `x-api-key` is missing or invalid |
| `RATE_LIMITED` | 429 | The client or comparison queue exceeded its configured limit |
| `INTERNAL` | 500 | Unexpected server failure |

All errors use `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`. Rate-limited responses include `Retry-After`.

### Production configuration

Copy `.env.example` and configure the values appropriate for the host:

- `API_KEY` optionally protects `/v1/compare` with the `x-api-key` header.
- `CORS_ORIGIN` enables browser clients from one or more comma-separated origins.
- `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` configure the per-process client limit.
- `MAX_CONCURRENT_COMPARISONS` and `MAX_QUEUED_COMPARISONS` protect CLIP inference resources.
- `TRUST_PROXY=true` is appropriate only behind a trusted reverse proxy.

## Benchmarks

The full benchmark uses 30 fixed COCO val2017 image IDs downloaded by `pnpm bench:data`. Each source has 31 deterministic attacks: four JPEG compression levels, three resizes, three blur levels, three noise levels, four brightness/contrast variants, three color variants, sharpen and flip, three center crops, two rotations, and four edits. Each attack produces one positive, one easy negative against an attacked different image, and one hard negative against the most similar different image using a 16 by 16 pixel signature.

Methods include shipped hand-tuned fusion, fitted logistic fusion, five layer ablations, ImageHash-style pHash similarity, SSIM, and the fallback baseline named exactly **color histogram correlation**. Every method gets its own threshold under the same two-fold split by source image. The headline is the average held-out result; in-sample tuning is separate and never substituted for the headline.

The generated result tables, real-number analysis, attack breakdown, layer latency, runtime versions, and eight SVG charts are inserted below by `pnpm readme:bench`.

<!-- BENCHMARK_RESULTS_START -->
### Dataset and run

- Images: 30
- Positive pairs: 930
- Easy negatives: 930
- Hard negatives: 930
- Seed: 20261027
- Runtime: v25.1.0, Sharp 0.32.6, 13th Gen Intel(R) Core(TM) i5-1335U

Headline metrics are two-fold cross-validated by source image. Thresholds and fitted logistic weights are trained only on each training fold before the held-out fold is scored. The separate in-sample table is intentionally not the headline result.

#### Held-out headline metrics

| Method | Accuracy | Precision | Recall | F1 | FPR | ROC AUC | TPR @ 1% FPR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fusion | 97.71% | 99.54% | 93.55% | 96.45% | 0.22% | 0.965 | 93.87% |
| fusion_fitted | 97.63% | 99.54% | 93.33% | 96.34% | 0.22% | 0.967 | 94.09% |
| hash only | 92.76% | 95.05% | 82.58% | 88.38% | 2.15% | 0.923 | 82.15% |
| embedding only | 97.78% | 100.00% | 93.33% | 96.55% | 0.00% | 0.972 | 94.09% |
| pixel only | 91.00% | 99.85% | 73.12% | 84.42% | 0.05% | 0.866 | 73.23% |
| hash + embedding | 97.49% | 99.20% | 93.23% | 96.12% | 0.38% | 0.964 | 93.87% |
| embedding + pixel | 97.74% | 99.88% | 93.33% | 96.50% | 0.05% | 0.972 | 94.09% |
| pHash Hamming similarity | 92.65% | 96.41% | 80.97% | 88.02% | 1.51% | 0.909 | 80.65% |
| SSIM | 92.51% | 94.89% | 81.94% | 87.94% | 2.20% | 0.948 | 79.57% |
| color histogram correlation | 89.93% | 91.76% | 76.67% | 83.54% | 3.44% | 0.906 | 68.39% |

#### Easy and hard negative splits

| Method | Easy accuracy | Hard accuracy | Easy FPR | Hard FPR |
| --- | ---: | ---: | ---: | ---: |
| fusion | 96.67% | 96.67% | 0.22% | 0.22% |
| fusion_fitted | 96.56% | 96.56% | 0.22% | 0.22% |
| hash only | 90.86% | 89.57% | 0.86% | 3.44% |
| embedding only | 96.67% | 96.67% | 0.00% | 0.00% |
| pixel only | 86.56% | 86.51% | 0.00% | 0.11% |
| hash + embedding | 96.45% | 96.40% | 0.32% | 0.43% |
| embedding + pixel | 96.67% | 96.61% | 0.00% | 0.11% |
| pHash Hamming similarity | 89.09% | 90.38% | 2.80% | 0.22% |
| SSIM | 90.22% | 89.52% | 1.51% | 2.90% |
| color histogram correlation | 86.88% | 86.34% | 2.90% | 3.98% |

#### In-sample reference metrics

| Method | Accuracy | Precision | Recall | F1 | FPR | ROC AUC | TPR @ 1% FPR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fusion | 97.78% | 100.00% | 93.33% | 96.55% | 0.00% | 0.965 | 93.87% |
| fusion_fitted | 97.78% | 100.00% | 93.33% | 96.55% | 0.00% | 0.966 | 94.09% |
| hash only | 93.76% | 99.09% | 82.04% | 89.76% | 0.38% | 0.923 | 82.15% |
| embedding only | 97.81% | 100.00% | 93.44% | 96.61% | 0.00% | 0.972 | 94.09% |
| pixel only | 91.04% | 99.85% | 73.23% | 84.49% | 0.05% | 0.866 | 73.23% |
| hash + embedding | 97.74% | 100.00% | 93.23% | 96.49% | 0.00% | 0.964 | 93.87% |
| embedding + pixel | 97.78% | 100.00% | 93.33% | 96.55% | 0.00% | 0.972 | 94.09% |
| pHash Hamming similarity | 93.41% | 99.47% | 80.65% | 89.07% | 0.22% | 0.909 | 80.65% |
| SSIM | 92.94% | 94.75% | 83.44% | 88.74% | 2.31% | 0.948 | 79.57% |
| color histogram correlation | 90.97% | 95.93% | 76.13% | 84.89% | 1.61% | 0.906 | 68.39% |

#### Recall by category for every method

| Method | compression | resize | blur | noise | brightness_contrast | color | filter_flip | crop | rotation | edits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fusion | 100.00% | 100.00% | 100.00% | 100.00% | 51.67% | 100.00% | 100.00% | 97.78% | 100.00% | 100.00% |
| fusion_fitted | 100.00% | 100.00% | 100.00% | 100.00% | 50.00% | 100.00% | 100.00% | 97.78% | 100.00% | 100.00% |
| hash only | 100.00% | 100.00% | 100.00% | 100.00% | 53.33% | 100.00% | 53.33% | 45.56% | 51.67% | 100.00% |
| embedding only | 100.00% | 100.00% | 100.00% | 100.00% | 50.00% | 100.00% | 100.00% | 97.78% | 100.00% | 100.00% |
| pixel only | 100.00% | 100.00% | 100.00% | 100.00% | 13.33% | 100.00% | 58.33% | 26.67% | 8.33% | 100.00% |
| hash + embedding | 100.00% | 100.00% | 100.00% | 100.00% | 51.67% | 100.00% | 100.00% | 94.44% | 100.00% | 100.00% |
| embedding + pixel | 100.00% | 100.00% | 100.00% | 100.00% | 50.00% | 100.00% | 100.00% | 97.78% | 100.00% | 100.00% |
| pHash Hamming similarity | 100.00% | 100.00% | 100.00% | 100.00% | 50.00% | 100.00% | 50.00% | 43.33% | 43.33% | 98.33% |
| SSIM | 100.00% | 100.00% | 100.00% | 100.00% | 61.67% | 100.00% | 60.00% | 34.44% | 35.00% | 100.00% |
| color histogram correlation | 100.00% | 100.00% | 98.89% | 90.00% | 8.33% | 63.33% | 100.00% | 85.56% | 31.67% | 91.67% |

#### Shipped fusion true-positive rate by attack

| Attack | Category | TPR |
| --- | --- | ---: |
| jpeg_90 | compression | 100.00% |
| jpeg_70 | compression | 100.00% |
| jpeg_50 | compression | 100.00% |
| jpeg_30 | compression | 100.00% |
| resize_75 | resize | 100.00% |
| resize_50 | resize | 100.00% |
| resize_25 | resize | 100.00% |
| blur_sigma_1 | blur | 100.00% |
| blur_sigma_2 | blur | 100.00% |
| blur_sigma_4 | blur | 100.00% |
| noise_sigma_10 | noise | 100.00% |
| noise_sigma_25 | noise | 100.00% |
| noise_sigma_50 | noise | 100.00% |
| brightness_plus_30 | brightness_contrast | 100.00% |
| brightness_minus_30 | brightness_contrast | 100.00% |
| contrast_0.6 | brightness_contrast | 3.33% |
| contrast_1.5 | brightness_contrast | 3.33% |
| grayscale | color | 100.00% |
| saturation_0.3 | color | 100.00% |
| saturation_2.0 | color | 100.00% |
| sharpen | filter_flip | 100.00% |
| horizontal_flip | filter_flip | 100.00% |
| center_crop_90 | crop | 100.00% |
| center_crop_75 | crop | 100.00% |
| center_crop_50 | crop | 93.33% |
| rotate_5 | rotation | 100.00% |
| rotate_15 | rotation | 100.00% |
| pasted_patch_5 | edits | 100.00% |
| pasted_patch_15 | edits | 100.00% |
| text_overlay | edits | 100.00% |
| blurred_rectangle_10 | edits | 100.00% |

#### Attack definitions

| Attack | Category |
| --- | --- |
| jpeg_90 | compression |
| jpeg_70 | compression |
| jpeg_50 | compression |
| jpeg_30 | compression |
| resize_75 | resize |
| resize_50 | resize |
| resize_25 | resize |
| blur_sigma_1 | blur |
| blur_sigma_2 | blur |
| blur_sigma_4 | blur |
| noise_sigma_10 | noise |
| noise_sigma_25 | noise |
| noise_sigma_50 | noise |
| brightness_plus_30 | brightness_contrast |
| brightness_minus_30 | brightness_contrast |
| contrast_0.6 | brightness_contrast |
| contrast_1.5 | brightness_contrast |
| grayscale | color |
| saturation_0.3 | color |
| saturation_2.0 | color |
| sharpen | filter_flip |
| horizontal_flip | filter_flip |
| center_crop_90 | crop |
| center_crop_75 | crop |
| center_crop_50 | crop |
| rotate_5 | rotation |
| rotate_15 | rotation |
| pasted_patch_5 | edits |
| pasted_patch_15 | edits |
| text_overlay | edits |
| blurred_rectangle_10 | edits |

#### Layer latency over the first 100 warm pairs

| Layer | p50 ms | p95 ms |
| --- | ---: | ---: |
| hash | 49.30 | 64.10 |
| embedding | 136.85 | 285.09 |
| pixel | 224.82 | 365.32 |
| ssim | 36.87 | 54.19 |
| histogram | 22.30 | 36.61 |

#### Charts

![ROC curves](docs/benchmarks/roc.svg)

![Accuracy and F1](docs/benchmarks/accuracy.svg)

![Per-attack heatmap](docs/benchmarks/per_attack_heatmap.svg)

![Per-category recall](docs/benchmarks/per_category.svg)

![Score distribution](docs/benchmarks/score_distribution.svg)

![Confusion matrix](docs/benchmarks/confusion_matrix.svg)

![Ablation](docs/benchmarks/ablation.svg)

![Latency](docs/benchmarks/latency.svg)

#### Where we win and where we lose

The best held-out accuracy in this run is **embedding only** at 97.78%; shipped hand-tuned fusion is 97.71%. Fusion's false-positive rate is 0.22% and its ROC AUC is 0.965. Fitted fusion does not beat shipped fusion on held-out accuracy in this run, so the shipped default weights remain unchanged. The full raw result, including every method's per-attack metrics and fold details, is in [bench/results.json](bench/results.json).
<!-- BENCHMARK_RESULTS_END -->

## Getting started

Install and run locally:

```bash
pnpm install
pnpm dev
```

The local development server defaults to port `3000`. The demo is at `http://localhost:3000/`.

Checks:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm bench:quick
```

Docker development, production, test, and benchmark commands:

```bash
docker-compose up api
docker-compose run --rm test
docker-compose run --rm bench pnpm bench:quick
docker build --target runtime -t image-similarity-api:runtime .
docker run --rm -p 7860:7860 image-similarity-api:runtime
```

The full COCO run is:

```bash
pnpm bench:data
pnpm bench
pnpm readme:bench
```

## Deployment

### Hugging Face Docker Space

Create a Docker Space with port `7860`, then set `HF_SPACE_URL` locally to the Space Git URL containing its write token. The deployment script refuses to run with a dirty working tree and never prints the URL.

```bash
HF_SPACE_URL=https://user:token@git.huggingface.co/spaces/user/space pnpm deploy:space
```

Use the exact URL supplied by Hugging Face; the example above intentionally shows the required shape and is not a real credential. The Space metadata lives in `deploy/hf/README.md`. The container binds to `0.0.0.0`, reads `PORT`, defaults to `7860` in the image, and serves the demo and API.

Other hosts can run the production Docker target or `pnpm start` behind a platform load balancer. The CLIP model should be baked into the image or cached on a persistent volume to avoid cold-download latency.

### Automated deployment and CI

All automation is defined in `.github/workflows/ci.yml`:

- Pull requests run typecheck, the test suite, the quick benchmark, a production Docker build, a Trivy vulnerability scan, and a local container smoke test.
- Pushes to `main` run the same verification first, then deploy the verified commit to Hugging Face.
- Deployment uses the repository Actions secret `HF_TOKEN`, which needs write access to `beluga-69/securepixel-ai-service`.
- The `production` environment can be configured in GitHub with required reviewers or other protection rules before deployment is allowed.
- Successful deployment verifies `/health/ready` and the identical, filtered, and tampered demo presets.

The workflow uses pnpm `11.25.0`, Node.js `22`, Docker Buildx GitHub Actions cache, and a non-blocking HIGH/CRITICAL Trivy scan (`ignore-unfixed: true`).

## Roadmap

- Queue-based asynchronous jobs
- Redis result and embedding caching
- Circuit breakers and graceful degradation controls
- Keypoint and RANSAC geometric alignment
- Object storage for large inputs and results

## Known limitations

- Crops and rotations are not aligned geometrically in the current MVP.
- The server is single-process.
- The embedding cache is in memory and is lost on restart.
- Free hosts can have cold starts while the model or container wakes up.
- Thresholds are benchmark starting points and should be evaluated against a target domain.

## Credits and license

The semantic layer uses the Xenova Transformers.js CLIP ViT-B/32 model. COCO val2017 images are downloaded from the official COCO image host for local benchmark reproduction. The project is released under the [MIT License](LICENSE).
