# Aurora: A Distributed Key-Value Store

A reference architecture for a multi-region, strongly consistent key-value store with tunable replication. Aurora is designed for workloads that need linearizable reads, replication across geographically distant regions, and predictable tail latency under partial failure.

## System Overview

Aurora partitions the keyspace into ranges. Each range is replicated across a configurable number of replicas using Raft. A coordinator service routes client requests to the appropriate range leader. Storage is pluggable; the reference implementation uses RocksDB.

```mermaid
flowchart LR
  subgraph Client Tier
    C1[Client SDK]
    C2[Client SDK]
  end
  subgraph Routing
    GW[Gateway]
    R[Range Router]
  end
  subgraph Storage Tier
    L1[Range Leader<br/>R1]
    F1[Follower<br/>R1]
    F2[Follower<br/>R1]
    L2[Range Leader<br/>R2]
    F3[Follower<br/>R2]
  end
  C1 --> GW
  C2 --> GW
  GW --> R
  R -->|key in R1| L1
  R -->|key in R2| L2
  L1 --- F1
  L1 --- F2
  L2 --- F3
```

## Read Path

Reads route to the range leader by default. A staleness-tolerant client may read from a follower with a bounded-staleness contract.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant G as Gateway
  participant R as Router
  participant L as Range Leader
  participant F as Follower
  C->>G: GET key=user:42
  G->>R: lookup(user:42)
  R-->>G: range R3, leader N7
  G->>L: read(user:42, consistency=linearizable)
  L->>L: serve from in-memory state
  L-->>G: value, MVCC ts=...
  G-->>C: 200 OK
  Note over C,F: Stale reads can short-circuit to F<br/>with bounded-staleness contract.
```

## Write Path

Writes go through Raft. The leader appends to its log, replicates to a quorum of followers, and applies to the state machine on commit.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant L as Leader
  participant F1 as Follower 1
  participant F2 as Follower 2
  C->>L: PUT key=order:7, val=...
  L->>L: append to local log
  par
    L->>F1: AppendEntries(idx=N)
    L->>F2: AppendEntries(idx=N)
  end
  F1-->>L: ack(N)
  F2-->>L: ack(N)
  L->>L: commit(N), apply to SM
  L-->>C: 200 OK, MVCC ts=...
```

## Replica State Machine

Each replica is a small state machine driven by Raft.

```mermaid
stateDiagram-v2
  [*] --> Follower
  Follower --> Candidate: election timeout
  Candidate --> Leader: majority vote
  Candidate --> Follower: higher term seen
  Leader --> Follower: higher term seen
  Leader --> [*]: shutdown
```

## Range Lifecycle

A range moves through a small set of states as it grows, splits, merges, or migrates.

```mermaid
stateDiagram-v2
  [*] --> Provisioning
  Provisioning --> Active: replicas joined quorum
  Active --> Splitting: size > threshold
  Splitting --> Active: split complete
  Active --> Merging: load < merge_threshold for adjacent ranges
  Merging --> Active: merge complete
  Active --> Migrating: rebalance triggered
  Migrating --> Active: migration complete
  Active --> Decommissioning: drain requested
  Decommissioning --> [*]
```

## Cluster Topology

Three regions, two zones each, three storage nodes per zone. The routing tier is region-local for predictable client latency.

```mermaid
flowchart TB
  subgraph US-East
    direction TB
    subgraph USE-A
      n1[Node]
      n2[Node]
      n3[Node]
    end
    subgraph USE-B
      n4[Node]
      n5[Node]
      n6[Node]
    end
  end
  subgraph EU-West
    subgraph EUW-A
      n7[Node]
      n8[Node]
      n9[Node]
    end
    subgraph EUW-B
      n10[Node]
      n11[Node]
      n12[Node]
    end
  end
  subgraph AP-South
    subgraph APS-A
      n13[Node]
      n14[Node]
      n15[Node]
    end
    subgraph APS-B
      n16[Node]
      n17[Node]
      n18[Node]
    end
  end
  US-East <--> EU-West
  EU-West <--> AP-South
  AP-South <--> US-East
```

## Schema and Indexing

User-facing entities are stored as sorted byte ranges. A secondary-index range references the primary by primary key.

```mermaid
classDiagram
  class Range {
    +id: u64
    +start_key: bytes
    +end_key: bytes
    +leader: NodeId
    +replicas: List~NodeId~
    +epoch: u64
    +size_bytes: u64
    +split() Range
    +merge(other: Range) Range
  }
  class Replica {
    +node_id: NodeId
    +log_index: u64
    +applied_index: u64
    +state: ReplicaState
  }
  class IndexRange {
    +index_name: str
    +column: str
    +primary_range_id: u64
  }
  Range "1" --o "n" Replica
  Range "1" --o "*" IndexRange
```

## Logical Schema

```mermaid
erDiagram
  USER ||--o{ ORDER : places
  USER {
    bigint id PK
    string email
    timestamp created_at
  }
  ORDER ||--o{ ORDER_ITEM : contains
  ORDER {
    bigint id PK
    bigint user_id FK
    string status
    decimal total
    timestamp placed_at
  }
  ORDER_ITEM {
    bigint id PK
    bigint order_id FK
    bigint product_id FK
    int qty
    decimal unit_price
  }
  PRODUCT ||--o{ ORDER_ITEM : referenced
  PRODUCT {
    bigint id PK
    string sku
    string name
    decimal price
  }
```

## Release Plan

We ship Aurora in three phases: a single-region preview, a cross-region beta, and general availability with strict SLAs.

```mermaid
gantt
  dateFormat  YYYY-MM-DD
  title Aurora Release Plan
  section Preview
  Single-region preview      :a1, 2026-01-15, 60d
  Stress / chaos testing     :a2, after a1, 30d
  section Beta
  Cross-region beta          :b1, after a2, 75d
  Customer onboarding        :b2, after b1, 30d
  section GA
  GA candidate freeze        :c1, after b2, 21d
  GA launch                  :c2, after c1, 7d
  Post-GA hardening          :c3, after c2, 60d
```

## Ops Journey

A walk-through of how a release lands and how on-call experiences a regional incident.

```mermaid
journey
  title Aurora release & incident journey
  section Release
    Open release PR: 4: SRE
    Run staging chaos suite: 3: SRE
    Canary one region: 4: SRE
    Promote to all regions: 5: SRE
  section Incident
    Page received at 03:14: 1: OnCall
    Confirm impact via dashboards: 2: OnCall
    Drain affected zone: 3: OnCall
    Rebalance ranges: 4: OnCall
    Write postmortem: 5: SRE
```

## Failure Modes

| Failure | Detection | Mitigation | Customer impact |
|---------|-----------|------------|------------------|
| Single replica down | Heartbeat timeout, 5s | Range leader continues with quorum | None |
| Leader down | Election timeout, 1.5s | New leader elected from quorum | ≤ 2s tail latency spike |
| Zone partition | Routing health check, 10s | Drain zone, reroute clients | Brief 5xx burst |
| Region partition | Cross-region probe, 30s | Demote region, serve other regions | Region-local writes blocked |
| Disk full | Storage telemetry, 60s | Move ranges, page on-call | Read-only fallback |
| Corrupted log | Checksum mismatch | Reload from snapshot, re-replicate | None if quorum healthy |

## Configuration Reference

```yaml
cluster:
  name: aurora-prod
  regions:
    - id: us-east
      zones: [a, b]
    - id: eu-west
      zones: [a, b]
    - id: ap-south
      zones: [a, b]

raft:
  election_timeout_ms: 1500
  heartbeat_interval_ms: 250
  max_inflight_msgs: 256
  snapshot_interval: 100000

storage:
  engine: rocksdb
  block_size_kb: 32
  compression: zstd
  bloom_bits_per_key: 12

rebalancer:
  enabled: true
  max_in_flight_moves: 8
  size_balance_pct: 5
  qps_balance_pct: 10
```

## Closing

Aurora's design follows a small set of choices: ranges as the unit of replication, Raft for ordering, range leases for routing, and operator-driven rebalancing. The remainder of this document is a deeper tour of each layer.
