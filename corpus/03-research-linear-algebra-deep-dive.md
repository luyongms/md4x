# Linear Algebra: A Concise Survey

A reference document covering the core theorems of finite-dimensional linear algebra over $\mathbb{R}$ and $\mathbb{C}$, with proofs of the spectral theorem, the singular-value decomposition, and the Jordan canonical form.

## Vector Spaces

A vector space over a field $\mathbb{F}$ is a set $V$ closed under two operations: vector addition $+ : V \times V \to V$ and scalar multiplication $\cdot : \mathbb{F} \times V \to V$, satisfying eight axioms — associativity and commutativity of addition, existence of identity and inverses, distributivity, and compatibility of scalar multiplication.

A subset $W \subseteq V$ is a *subspace* if $W$ is itself a vector space under the inherited operations. Equivalently, $W$ is non-empty and closed under linear combinations: for all $u, v \in W$ and $\alpha, \beta \in \mathbb{F}$, $\alpha u + \beta v \in W$.

### Linear Independence and Bases

A finite set $\{v_1, \dots, v_k\} \subseteq V$ is *linearly independent* if the only solution to $\sum_{i=1}^k \alpha_i v_i = 0$ is $\alpha_1 = \cdots = \alpha_k = 0$.

A *basis* of $V$ is a linearly independent spanning set. Every finite-dimensional vector space has a basis, and any two bases of $V$ have the same cardinality, called the *dimension* and denoted $\dim V$.

> **Theorem 1.1** (Replacement Lemma). Let $V$ be a vector space and let $\{v_1, \dots, v_n\}$ be a basis of $V$. If $\{w_1, \dots, w_k\}$ is linearly independent in $V$, then $k \leq n$, and after a suitable reordering of the $v_i$ we may replace $v_1, \dots, v_k$ with $w_1, \dots, w_k$ to obtain another basis of $V$.

### Direct Sums

Given subspaces $U, W \subseteq V$, the *sum* is $U + W = \{ u + w : u \in U, w \in W \}$, and the *direct sum* $U \oplus W$ is the sum subject to $U \cap W = \{0\}$. Equivalently, every $v \in U \oplus W$ has a unique decomposition $v = u + w$ with $u \in U$ and $w \in W$.

The dimension formula:

$$\dim(U + W) = \dim U + \dim W - \dim(U \cap W).$$

## Linear Maps

A *linear map* $T : V \to W$ between vector spaces over $\mathbb{F}$ satisfies $T(\alpha u + \beta v) = \alpha T(u) + \beta T(v)$. The *kernel* and *image* are subspaces:

$$\ker T = \{ v \in V : T(v) = 0 \}, \qquad \mathrm{im}\, T = \{ T(v) : v \in V \}.$$

> **Theorem 2.1** (Rank–Nullity). Let $T : V \to W$ be linear with $\dim V < \infty$. Then $\dim \ker T + \dim \mathrm{im}\, T = \dim V$.

*Proof sketch.* Choose a basis $\{u_1, \dots, u_k\}$ of $\ker T$, extend it to a basis $\{u_1, \dots, u_k, v_1, \dots, v_m\}$ of $V$, and verify that $\{T(v_1), \dots, T(v_m)\}$ is a basis of $\mathrm{im}\, T$. $\blacksquare$

### Matrix Representation

Fix bases $\mathcal{B} = (v_1, \dots, v_n)$ of $V$ and $\mathcal{C} = (w_1, \dots, w_m)$ of $W$. The *matrix of $T$* in these bases is the $m \times n$ matrix $A = [a_{ij}]$ defined by

$$T(v_j) = \sum_{i=1}^m a_{ij} \, w_i.$$

A change of basis $\mathcal{B} \to \mathcal{B}'$ is governed by an invertible matrix $P$, and the matrix of $T$ in the new basis is $P^{-1} A P$ (when $V = W$ and we use the same basis on both sides).

## Inner Products and Norms

An *inner product* on a real vector space $V$ is a map $\langle \cdot, \cdot \rangle : V \times V \to \mathbb{R}$ that is bilinear, symmetric, and positive-definite:

$$\langle u, u \rangle \geq 0, \qquad \langle u, u \rangle = 0 \iff u = 0.$$

For complex spaces, the inner product is *sesquilinear*: $\langle u, v \rangle = \overline{\langle v, u \rangle}$ and conjugate-linear in the second argument.

The induced norm is $\|v\| = \sqrt{\langle v, v \rangle}$.

> **Theorem 3.1** (Cauchy–Schwarz). For all $u, v \in V$,
>
> $$|\langle u, v \rangle| \leq \|u\| \cdot \|v\|,$$
>
> with equality if and only if $u$ and $v$ are linearly dependent.

> **Theorem 3.2** (Triangle inequality). $\|u + v\| \leq \|u\| + \|v\|$, with equality iff $u$ and $v$ point in the same direction.

### Orthogonality and Projections

Two vectors $u, v \in V$ are *orthogonal* if $\langle u, v \rangle = 0$. A set $\{e_1, \dots, e_n\}$ is *orthonormal* if $\langle e_i, e_j \rangle = \delta_{ij}$.

The *orthogonal projection* of $v \in V$ onto $W \subseteq V$ is the unique $\mathrm{proj}_W v \in W$ such that $v - \mathrm{proj}_W v \in W^\perp$. If $\{e_1, \dots, e_k\}$ is an orthonormal basis of $W$, then

$$\mathrm{proj}_W v = \sum_{i=1}^k \langle v, e_i \rangle \, e_i.$$

Bessel's inequality:

$$\sum_{i=1}^k |\langle v, e_i \rangle|^2 \leq \|v\|^2.$$

## Eigenvalues and Eigenvectors

An *eigenvalue* of $T : V \to V$ is $\lambda \in \mathbb{F}$ such that $T v = \lambda v$ for some non-zero $v$, called an *eigenvector*. The set of eigenvectors of $T$ with eigenvalue $\lambda$, together with $0$, forms the *eigenspace* $E_\lambda = \ker(T - \lambda I)$.

The *characteristic polynomial* is $p_T(t) = \det(tI - A)$ where $A$ is any matrix of $T$. The eigenvalues of $T$ are the roots of $p_T$.

> **Theorem 4.1** (Cayley–Hamilton). Every linear operator $T$ on a finite-dimensional vector space satisfies its own characteristic polynomial: $p_T(T) = 0$.

### Diagonalization

$T$ is *diagonalizable* iff $V$ has a basis of eigenvectors of $T$. Equivalently, the algebraic multiplicity of each eigenvalue equals its geometric multiplicity (the dimension of the eigenspace).

In matrix terms: $A$ is diagonalizable iff $A = P D P^{-1}$ for some invertible $P$ and diagonal $D$.

## The Spectral Theorem

For a real symmetric (or complex Hermitian) operator $T$ on a finite-dimensional inner-product space, eigenvalues are real and eigenvectors corresponding to distinct eigenvalues are orthogonal.

> **Theorem 5.1** (Spectral Theorem, real symmetric case). Let $T : V \to V$ be self-adjoint on a real inner-product space $V$ with $\dim V = n$. Then $V$ has an orthonormal basis $(e_1, \dots, e_n)$ of eigenvectors of $T$. Equivalently, the matrix $A$ of $T$ in any orthonormal basis satisfies $A = Q \Lambda Q^\top$ where $Q$ is orthogonal and $\Lambda$ is diagonal.

The complex Hermitian case is analogous, with $Q$ unitary and $A = Q \Lambda Q^*$.

### Quadratic Forms

A *quadratic form* $q(v) = \langle v, T v \rangle$ for self-adjoint $T$ has a *signature* $(p, q, r)$ where $p, q, r$ count positive, negative, and zero eigenvalues. The form is *positive-definite* iff all eigenvalues are positive.

The Rayleigh quotient is

$$\mathcal{R}_T(v) = \frac{\langle v, T v \rangle}{\langle v, v \rangle},$$

and its extremes equal the largest and smallest eigenvalues of $T$:

$$\lambda_{\max}(T) = \max_{v \neq 0} \mathcal{R}_T(v), \qquad \lambda_{\min}(T) = \min_{v \neq 0} \mathcal{R}_T(v).$$

## The Singular-Value Decomposition

For any $A \in \mathbb{R}^{m \times n}$ there exist orthogonal matrices $U \in \mathbb{R}^{m \times m}$ and $V \in \mathbb{R}^{n \times n}$ and a diagonal $\Sigma \in \mathbb{R}^{m \times n}$ with non-negative entries $\sigma_1 \geq \sigma_2 \geq \cdots \geq \sigma_r > 0 = \sigma_{r+1} = \cdots$ such that

$$A = U \Sigma V^\top.$$

The $\sigma_i$ are the *singular values* of $A$, $r = \mathrm{rank}\, A$, and the columns of $U$ and $V$ are the *left* and *right singular vectors*. Equivalent reformulation:

$$A v_i = \sigma_i u_i, \qquad A^\top u_i = \sigma_i v_i, \qquad i = 1, \dots, r.$$

### The Eckart–Young Theorem

For $A \in \mathbb{R}^{m \times n}$ with singular values $\sigma_1 \geq \cdots \geq \sigma_r > 0$, the best rank-$k$ approximation under the Frobenius norm is

$$A_k = \sum_{i=1}^k \sigma_i u_i v_i^\top, \qquad \|A - A_k\|_F^2 = \sum_{i=k+1}^r \sigma_i^2.$$

The same $A_k$ is also optimal under the spectral (operator) norm, with $\|A - A_k\|_2 = \sigma_{k+1}$.

## Jordan Canonical Form

Over an algebraically closed field, every operator $T$ on a finite-dimensional vector space admits a basis in which its matrix is *Jordan*: a block-diagonal matrix whose blocks are of the form

$$J_k(\lambda) = \begin{pmatrix} \lambda & 1 & & \\ & \lambda & \ddots & \\ & & \ddots & 1 \\ & & & \lambda \end{pmatrix} \in \mathbb{F}^{k \times k}.$$

The set of pairs $(\lambda, k)$, with multiplicities, is determined by $T$ and is a complete invariant up to similarity.

For non-diagonalizable matrices, the Jordan form refines the eigendecomposition by exposing the *generalized eigenspaces* $\bigcup_{m \geq 1} \ker (T - \lambda I)^m$.

## Norms on Matrices

Several norms on $\mathbb{R}^{m \times n}$ play different roles in numerical analysis:

| Norm | Definition | Use |
|------|------------|-----|
| Frobenius | $\|A\|_F = \sqrt{\sum_{i,j} a_{ij}^2}$ | least-squares fit, low-rank approximation |
| Spectral | $\|A\|_2 = \sigma_{\max}(A)$ | conditioning, perturbation bounds |
| Nuclear | $\|A\|_* = \sum_i \sigma_i(A)$ | convex relaxation of rank |
| 1-norm | $\max_j \sum_i |a_{ij}|$ | sparse approximation, $L^1$ regression |
| Infinity | $\max_i \sum_j |a_{ij}|$ | row-stochastic bounds |

Their pairwise relationships (with $r = \mathrm{rank}\, A$) include $\|A\|_2 \leq \|A\|_F \leq \sqrt{r}\, \|A\|_2$ and $\|A\|_2 \leq \|A\|_* \leq \sqrt{r}\, \|A\|_F$.

## Block Matrices and the Schur Complement

For a block matrix

$$M = \begin{pmatrix} A & B \\ C & D \end{pmatrix}$$

with $A$ invertible, the *Schur complement* of $A$ in $M$ is $S = D - C A^{-1} B$. Determinant identity:

$$\det M = \det A \cdot \det S.$$

And $M$ is invertible iff $A$ and $S$ are. The block inverse is

$$M^{-1} = \begin{pmatrix} A^{-1} + A^{-1} B S^{-1} C A^{-1} & -A^{-1} B S^{-1} \\ -S^{-1} C A^{-1} & S^{-1} \end{pmatrix}.$$

## Applications to Optimization

The unconstrained quadratic program $\min_x \tfrac{1}{2} x^\top Q x - b^\top x$ with $Q$ symmetric positive-definite has the closed-form solution $x^* = Q^{-1} b$ and minimum value $-\tfrac{1}{2} b^\top Q^{-1} b$.

The KKT conditions for the equality-constrained problem $\min \tfrac{1}{2} x^\top Q x - b^\top x$ subject to $Ax = c$ form a single linear system

$$\begin{pmatrix} Q & A^\top \\ A & 0 \end{pmatrix} \begin{pmatrix} x \\ \lambda \end{pmatrix} = \begin{pmatrix} b \\ c \end{pmatrix},$$

solvable when the constraints are consistent and $Q$ is PSD on $\ker A$.

## Closing

The themes recur: choose a basis well, decompose into invariants, project onto a subspace, and minimize a quadratic. Almost every applied problem in linear algebra reduces to one of these.
