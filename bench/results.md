# Benchmark results

Evaluated 20 source images, 160 positive pairs, and 160 negative pairs.

| Method | Chosen threshold | Accuracy | False positive rate | Average latency (ms) |
| --- | ---: | ---: | ---: | ---: |
| full fusion | 0.919 | 84.38% | 5.00% | 89.400 |
| pHash only | 0.941 | 83.75% | 0.00% | 18.405 |
| pixel difference only | 0.987 | 85.31% | 5.00% | 18.099 |
