# Embedding eval — 2026-10-23

Corpus: 8 synthetic credit policies, 35 sections. 60 labelled queries:
30 dev / 30 frozen held-out. Retrieval is exact cosine; quotes and citations
are not part of this eval.

**Winner: `voyageai/voyage-4-large` (1024 dims).**

| Model                         | Dims | Dev recall@5 | Held-out recall@5 | Wilson 95%  | Held-out exact |
| ----------------------------- | ---: | -----------: | ----------------: | ----------- | -------------: |
| voyageai/voyage-4-large       | 1024 |        1.000 |         **1.000** | 0.886–1.000 |      **0.967** |
| voyageai/voyage-4             | 1024 |        1.000 |             1.000 | 0.886–1.000 |          0.833 |
| qwen/qwen3-embedding-8b       | 4096 |        1.000 |             1.000 | 0.886–1.000 |          0.800 |
| openai/text-embedding-3-large | 3072 |        1.000 |             0.967 | 0.833–0.994 |          0.767 |
| perplexity/pplx-embed-v1-0.6b | 1024 |        1.000 |             0.967 | 0.833–0.994 |          0.767 |
| openai/text-embedding-3-small | 1536 |        1.000 |             0.933 | 0.787–0.982 |          0.733 |
| baai/bge-m3                   | 1024 |        1.000 |             0.900 | 0.744–0.965 |          0.700 |

Selection rule: held-out recall@5, then lower confidence bound, then smaller
dimension/cost. `voyage-4-large` also had the highest exact-section hit, so
the 1024-dimension choice is not a cost/quality compromise.

Raw rows (local, gitignored): `embedding-20261023T160804Z.json`. OpenRouter `/models` does not
list these embedding IDs, but `/embeddings` accepted every candidate; the
runner records `listedInModels=false`.

This is a synthetic corpus, not a production quality estimate. Re-run with
real officer queries and a larger corpus before relying on the absolute
scores.
