# Linear Algebra in Two Pages

A demonstration document for the STEM textbook template — academic typography, numbered structure, theorem-style callouts, and inline mathematical notation.

## Vectors

A vector $\vec{v} \in \mathbb{R}^n$ is an ordered $n$-tuple of real numbers. Vectors form the basic objects of linear algebra. They can be added componentwise and scaled by a real number, operations that obey the usual associative, commutative, and distributive laws.

### Definition

Formally, a real vector space is a set $V$ equipped with two operations: vector addition $+ : V \times V \to V$ and scalar multiplication $\cdot : \mathbb{R} \times V \to V$, subject to eight axioms.

### Operations

The inner product (or dot product) of two vectors $\vec{u}, \vec{v} \in \mathbb{R}^n$ is

$$
\langle \vec{u}, \vec{v} \rangle = \sum_{i=1}^n u_i v_i.
$$

The norm is $\|\vec{v}\| = \sqrt{\langle \vec{v}, \vec{v} \rangle}$. These two definitions give us the geometric notions of length and angle in $\mathbb{R}^n$.

> **Theorem 1.1** (Cauchy–Schwarz inequality). For any vectors $\vec{u}, \vec{v}$ in an inner product space,
>
> $$|\langle \vec{u}, \vec{v} \rangle| \leq \|\vec{u}\| \cdot \|\vec{v}\|,$$
>
> with equality if and only if $\vec{u}$ and $\vec{v}$ are linearly dependent.

The Cauchy–Schwarz inequality is a foundational tool — it underpins the triangle inequality, the convergence of series in normed spaces, and bounds in probability such as the covariance inequality.

## Matrices

A matrix $A \in \mathbb{R}^{m \times n}$ is a rectangular array of real numbers with $m$ rows and $n$ columns. We write $A_{ij}$ for the entry in the $i$-th row and $j$-th column.

### Multiplication

Given $A \in \mathbb{R}^{m \times n}$ and $B \in \mathbb{R}^{n \times p}$, their product $AB \in \mathbb{R}^{m \times p}$ has entries

$$
(AB)_{ij} = \sum_{k=1}^{n} A_{ik} B_{kj}.
$$

Matrix multiplication is associative but not commutative: in general $AB \neq BA$.

### A naive implementation

The textbook definition translates directly into nested loops. The following Python is correct but inefficient — production code should use a tuned BLAS routine.

```python
import numpy as np

def matmul(A, B):
    m, n = A.shape
    n2, p = B.shape
    assert n == n2, "inner dimensions must match"
    C = np.zeros((m, p))
    for i in range(m):
        for j in range(p):
            for k in range(n):
                C[i, j] += A[i, k] * B[k, j]
    return C
```

### Asymptotic cost

The naive algorithm above runs in $O(mnp)$ time. For square matrices ($m = n = p$) this is $O(n^3)$. Strassen's algorithm (1969) reduces the exponent to $\log_2 7 \approx 2.807$, and the current state of the art (as of 2024) achieves $O(n^{2.371552})$, though the constants make it impractical below astronomical sizes.

| Algorithm | Year | Exponent |
|-----------|------|----------|
| Naive | classical | 3 |
| Strassen | 1969 | 2.807 |
| Coppersmith–Winograd | 1990 | 2.376 |
| Williams et al. | 2024 | 2.371552 |

## Conclusion

This document demonstrates the STEM template's treatment of mathematical notation, numbered structure, theorem-style callouts, code listings, and tables. The body type is Charter; headings are Helvetica; math is rendered by KaTeX; and a single navy accent (#1e3a5f) carries the visual hierarchy.
