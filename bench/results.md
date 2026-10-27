# Benchmark results

Generated from 30 images and 2790 pairs with seed 20261027. Headline metrics are two-fold cross-validated by source image; in-sample metrics are reported separately in the JSON.

## Held-out headline results

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

## Where this run wins and loses

On the held-out folds, **embedding only** has the highest accuracy at 97.78%; the shipped fusion scores 97.71%.

## Reproduce

`pnpm bench:data` downloads and verifies the COCO inputs. Then run `pnpm bench` for the full benchmark or `pnpm bench:quick` for the offline starter check.
