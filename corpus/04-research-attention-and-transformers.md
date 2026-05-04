# Attention, Transformers, and Their Variants

A self-contained survey of the attention mechanism and the transformer architecture, with emphasis on the algebra rather than the implementation. Aimed at readers who want to understand why each component is in the model and how the variants differ from one another.

## The Attention Mechanism

Given a *query* $q \in \mathbb{R}^d$, a set of *keys* $k_1, \dots, k_n \in \mathbb{R}^d$, and *values* $v_1, \dots, v_n \in \mathbb{R}^{d_v}$, scaled dot-product attention computes

$$\mathrm{Attn}(q, K, V) = \sum_{i=1}^n \mathrm{softmax}\!\left( \frac{q^\top k_i}{\sqrt{d}} \right) v_i.$$

Stacking $h$ queries into a matrix $Q \in \mathbb{R}^{h \times d}$, the operation generalizes to

$$\mathrm{Attn}(Q, K, V) = \mathrm{softmax}\!\left( \frac{Q K^\top}{\sqrt{d}} \right) V,$$

with softmax applied row-wise. The factor $1 / \sqrt{d}$ keeps the pre-softmax scores from saturating as $d$ grows.

### Why scale by $\sqrt{d}$?

If $q$ and $k$ are independent random vectors with i.i.d.\ unit-variance entries, then $\mathrm{Var}(q^\top k) = d$ and $\mathrm{Var}(q^\top k / \sqrt{d}) = 1$. Without the scale, the softmax inputs grow like $\sqrt{d}$ and concentrate on a single entry, producing vanishing gradients.

### Multi-Head Attention

Multi-head attention runs $h$ attention heads in parallel, each with its own learned projections. With learned matrices $W^Q_i, W^K_i \in \mathbb{R}^{d \times d_k}$ and $W^V_i \in \mathbb{R}^{d \times d_v}$,

$$\mathrm{head}_i = \mathrm{Attn}(X W^Q_i, X W^K_i, X W^V_i),$$

and the heads are concatenated and projected:

$$\mathrm{MHA}(X) = [\mathrm{head}_1; \dots; \mathrm{head}_h] W^O, \qquad W^O \in \mathbb{R}^{h d_v \times d}.$$

In the canonical configuration, $d_k = d_v = d / h$, so the per-head budget is $h$ times smaller than a single $d$-wide attention.

## The Transformer Block

A transformer encoder block applies multi-head self-attention followed by a position-wise feed-forward network, with residual connections and layer normalization around each sub-layer.

$$\begin{aligned}
y &= \mathrm{LN}(x + \mathrm{MHA}(x)), \\
z &= \mathrm{LN}(y + \mathrm{FFN}(y)).
\end{aligned}$$

The feed-forward network is

$$\mathrm{FFN}(y) = \mathrm{GELU}(y W_1 + b_1) W_2 + b_2, \qquad W_1 \in \mathbb{R}^{d \times d_{\mathrm{ff}}}, W_2 \in \mathbb{R}^{d_{\mathrm{ff}} \times d}.$$

The hidden width $d_{\mathrm{ff}}$ is typically $4 d$.

### Pre-LayerNorm vs.\ Post-LayerNorm

Two placements of layer normalization produce different training behaviors:

- **Post-LN** (original): $y = \mathrm{LN}(x + \mathrm{MHA}(x))$.
- **Pre-LN**: $y = x + \mathrm{MHA}(\mathrm{LN}(x))$.

Pre-LN trains stably without learning-rate warmup; Post-LN often requires it but yields slightly better final loss with careful tuning. Most modern systems use Pre-LN.

## Positional Encodings

Self-attention is permutation-equivariant. A positional signal must be added to break this symmetry.

### Sinusoidal Encodings

The original transformer uses fixed sinusoidal encodings:

$$\mathrm{PE}_{(p, 2i)} = \sin\!\left( \frac{p}{10000^{2i / d}} \right), \qquad \mathrm{PE}_{(p, 2i+1)} = \cos\!\left( \frac{p}{10000^{2i / d}} \right),$$

added to token embeddings. They allow extrapolation to longer sequences than seen at training time, in principle.

### Rotary Position Embeddings (RoPE)

RoPE rotates pairs of channels $(2i, 2i+1)$ by an angle $\theta_{p, i} = p \cdot 10000^{-2i/d}$ before computing dot products. For a pair $(q_{2i}, q_{2i+1})$,

$$\begin{pmatrix} q'_{2i} \\ q'_{2i+1} \end{pmatrix} = \begin{pmatrix} \cos \theta_{p,i} & -\sin \theta_{p,i} \\ \sin \theta_{p,i} & \cos \theta_{p,i} \end{pmatrix} \begin{pmatrix} q_{2i} \\ q_{2i+1} \end{pmatrix}.$$

Critically, the dot product after rotation depends only on the relative offset $p - p'$, giving a translation-equivariant attention pattern.

### ALiBi

ALiBi adds a linear position bias to attention scores: $\mathrm{score}_{ij} = q_i^\top k_j - m \cdot |i - j|$ where $m$ is a head-specific slope. Has good extrapolation behavior and no learned parameters.

## Self-Attention as Message Passing

Self-attention can be viewed as message passing on a fully-connected graph where edge weights are softmax-normalized scores. With $n$ tokens,

$$\alpha_{ij} = \frac{\exp(q_i^\top k_j / \sqrt{d})}{\sum_{j'} \exp(q_i^\top k_{j'} / \sqrt{d})}, \qquad x'_i = \sum_j \alpha_{ij} v_j.$$

The $O(n^2)$ cost comes from the dense edge structure. Most efficient-attention variants reduce this either by sparsifying edges or by approximating the softmax with a kernel.

## Efficient Attention Variants

| Variant | Time | Memory | Idea |
|---------|------|--------|------|
| Vanilla | $O(n^2 d)$ | $O(n^2 + n d)$ | dense softmax |
| Sparse (Longformer / BigBird) | $O(n d)$ | $O(n d)$ | local + global attention pattern |
| Linear (Performer) | $O(n d^2)$ | $O(n d)$ | random-feature approximation of softmax |
| Linformer | $O(n d k)$ | $O(n k)$ | low-rank projection of K, V |
| FlashAttention | $O(n^2 d)$ | $O(n d)$ | tile, fuse, recompute in SRAM |

FlashAttention is exact, not approximate — it changes the *implementation* (tiling and recomputation) without altering the math.

## Scaling Laws

Empirical work has shown that loss as a function of compute, parameters, and tokens follows a power law on log-log axes. A widely cited fit is

$$\mathcal{L}(N, D) \approx \mathcal{L}_\infty + \frac{A}{N^\alpha} + \frac{B}{D^\beta},$$

with $N$ the parameter count, $D$ the training-token count, and $\alpha, \beta \in (0, 1)$. The compute-optimal allocation balances $N$ and $D$ so that the marginal returns are equal.

## Optimization

### AdamW

The standard optimizer for transformers is AdamW, decoupling weight decay from the gradient update:

$$\begin{aligned}
m_t &= \beta_1 m_{t-1} + (1 - \beta_1) g_t, \\
v_t &= \beta_2 v_{t-1} + (1 - \beta_2) g_t^2, \\
\hat m_t &= \frac{m_t}{1 - \beta_1^t}, \quad \hat v_t = \frac{v_t}{1 - \beta_2^t}, \\
\theta_t &= \theta_{t-1} - \eta \left( \frac{\hat m_t}{\sqrt{\hat v_t} + \epsilon} + \lambda \theta_{t-1} \right).
\end{aligned}$$

### Warmup and Schedule

A cosine learning-rate schedule with linear warmup is canonical:

$$\eta(t) = \begin{cases}
\eta_{\max} \cdot t / T_w & t < T_w, \\
\eta_{\min} + \tfrac{1}{2}(\eta_{\max} - \eta_{\min})(1 + \cos(\pi (t - T_w) / (T - T_w))) & T_w \leq t \leq T.
\end{cases}$$

## Training Stability

Two empirical knobs that disproportionately affect stability:

1. **Embedding initialization scale** — small ($\sigma \approx 0.02$) for input embeddings; the FFN's second linear typically initialized to zero.
2. **Gradient clipping** — global $L^2$ clip at value $1.0$ is standard. Without it, occasional outlier batches blow up activations and require restart from a checkpoint.

The pre-norm formulation, AdamW, gradient clipping, and warmup together account for most of the stability gap between "trains" and "diverges" in practice.

## Regularization

Dropout is applied inside attention (on the softmax weights) and inside the FFN (after the activation). Modern systems often disable attention dropout but keep residual dropout. Other techniques:

- **Layer drop**: randomly skip whole transformer blocks during training.
- **Stochastic depth**: scale residual contributions by a Bernoulli random variable.
- **Label smoothing**: replace one-hot targets $y$ with $(1 - \epsilon) y + \epsilon / |V|$, reducing overconfidence.

## Mixture of Experts

In an MoE layer, a router selects $k$ experts (out of $E$) per token. Each expert is an FFN. With router logits $r(x) \in \mathbb{R}^E$ and top-$k$ gates,

$$\mathrm{MoE}(x) = \sum_{i \in \mathrm{TopK}(r(x))} \mathrm{softmax}(r(x))_i \cdot \mathrm{FFN}_i(x).$$

Training requires a load-balancing auxiliary loss to prevent the router from collapsing onto a few experts:

$$\mathcal{L}_{\mathrm{aux}} = E \sum_{i=1}^E f_i \cdot p_i,$$

where $f_i$ is the fraction of tokens routed to expert $i$ and $p_i$ is the average router probability for expert $i$.

## Encoder–Decoder vs.\ Decoder-Only

Three macro-architectures dominate:

| Architecture | Examples | Use |
|--------------|----------|-----|
| Encoder-only | BERT, RoBERTa | classification, retrieval |
| Decoder-only | GPT, LLaMA | generation, in-context learning |
| Encoder–decoder | T5, BART | seq2seq, translation |

Decoder-only models train with a causal mask and a next-token objective; encoder-only models train with masked-token reconstruction. The empirical evidence for in-context generalization at scale has shifted attention toward decoder-only systems, but encoder–decoder remains preferred for tasks with cleanly separated input and output.

## Closing

The transformer's lasting innovation is not any single component but the absence of recurrence and the constant-depth, content-addressable mixing of token representations. Variants since 2017 have refined the implementation; the algebraic core has not changed.
