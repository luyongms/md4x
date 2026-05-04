# Helios: Event-Driven Platform Architecture

A reference platform architecture for an event-driven enterprise system spanning ingest, processing, storage, and serving. Helios assumes mixed workloads (transactional, analytical, ML) and a "log as the source of truth" data philosophy.

## Logical Layers

```mermaid
flowchart TB
  subgraph "Edge"
    A1[Web Apps]
    A2[Mobile Apps]
    A3[Partners API]
  end
  subgraph "Ingest"
    B1[API Gateway]
    B2[Event Collector]
    B3[Schema Registry]
  end
  subgraph "Backbone"
    C1[(Kafka<br/>raw topics)]
    C2[(Kafka<br/>derived topics)]
  end
  subgraph "Process"
    D1[Stream Workers]
    D2[Batch Jobs]
    D3[ML Inference]
  end
  subgraph "Store"
    E1[(OLTP<br/>Postgres)]
    E2[(OLAP<br/>ClickHouse)]
    E3[(Lake<br/>S3 + Iceberg)]
    E4[(Vector<br/>store)]
  end
  subgraph "Serve"
    F1[GraphQL]
    F2[REST]
    F3[Search API]
  end
  A1 --> B1
  A2 --> B1
  A3 --> B1
  B1 --> B2
  B2 --> B3
  B2 --> C1
  C1 --> D1
  C1 --> D2
  D1 --> C2
  D1 --> E1
  D2 --> E2
  D2 --> E3
  D3 --> E4
  E1 --> F1
  E1 --> F2
  E2 --> F1
  E4 --> F3
```

## End-to-End Order Flow

A canonical "place an order" trace across the platform.

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as Web App
  participant G as Gateway
  participant O as Orders Service
  participant P as Payments Service
  participant K as Kafka
  participant I as Inventory Worker
  participant N as Notifications Worker
  U->>W: click "Place Order"
  W->>G: POST /orders
  G->>O: createOrder(cart)
  O->>P: authorize(amount)
  P-->>O: auth_id, status=AUTHORIZED
  O->>K: emit OrderPlaced
  par
    K->>I: OrderPlaced
    I->>I: reserve stock
    I->>K: emit StockReserved
  and
    K->>N: OrderPlaced
    N->>U: email "Thanks for your order"
  end
  O-->>G: order_id, status=CREATED
  G-->>W: 201 Created
```

## Saga: Refund

A refund spans Payments, Orders, and Notifications, coordinated as a saga via the event log.

```mermaid
sequenceDiagram
  autonumber
  participant Sup as Support Agent
  participant O as Orders
  participant K as Kafka
  participant P as Payments
  participant N as Notifications
  Sup->>O: refund(order_id, reason)
  O->>K: emit RefundRequested
  K->>P: RefundRequested
  P->>P: void or reverse charge
  alt success
    P->>K: emit RefundCompleted
    K->>O: RefundCompleted
    O->>O: mark order REFUNDED
    K->>N: RefundCompleted
    N->>Sup: notify customer
  else failure
    P->>K: emit RefundFailed
    K->>O: RefundFailed
    O->>O: mark order REFUND_FAILED
    K->>Sup: alert escalation
  end
```

## Service Mesh

```mermaid
flowchart LR
  subgraph Edge
    LB[(Load Balancer)]
  end
  subgraph "Mesh: traffic + telemetry"
    LB --> Gateway
    Gateway -->|mTLS| Orders
    Gateway -->|mTLS| Catalog
    Orders -->|mTLS| Payments
    Orders -->|mTLS| Inventory
    Orders -.->|emit| Backbone[(Event Backbone)]
    Catalog -.->|emit| Backbone
    Inventory -.->|emit| Backbone
    Payments -.->|emit| Backbone
  end
  subgraph "Observability"
    Tracing[Distributed Tracing]
    Metrics[Time-series Metrics]
    Logs[Structured Logs]
  end
  Orders -.-> Tracing
  Catalog -.-> Tracing
  Payments -.-> Tracing
  Inventory -.-> Tracing
  Tracing -.-> Logs
  Tracing -.-> Metrics
```

## Domain Model

```mermaid
classDiagram
  class Customer {
    +id: UUID
    +email: str
    +tier: enum
    +createdAt: timestamp
  }
  class Address {
    +id: UUID
    +line1: str
    +city: str
    +country: str
  }
  class Order {
    +id: UUID
    +customerId: UUID
    +status: OrderStatus
    +placedAt: timestamp
    +total: Money
  }
  class LineItem {
    +id: UUID
    +orderId: UUID
    +sku: str
    +qty: int
    +unitPrice: Money
  }
  class Payment {
    +id: UUID
    +orderId: UUID
    +method: PaymentMethod
    +status: PaymentStatus
    +amount: Money
    +authorizedAt: timestamp
  }
  class Shipment {
    +id: UUID
    +orderId: UUID
    +carrier: str
    +tracking: str
    +status: ShipmentStatus
  }
  Customer "1" -- "*" Order
  Customer "1" -- "*" Address
  Order "1" -- "*" LineItem
  Order "1" -- "1" Payment
  Order "1" -- "0..*" Shipment
```

## ER View

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER ||--o{ ADDRESS : has
  ORDER ||--|{ LINE_ITEM : contains
  ORDER ||--|| PAYMENT : settles_with
  ORDER ||--o{ SHIPMENT : ships_via
  PRODUCT ||--o{ LINE_ITEM : sold_as
  CUSTOMER {
    uuid id PK
    string email
    enum tier
    timestamp created_at
  }
  ORDER {
    uuid id PK
    uuid customer_id FK
    enum status
    decimal total
    timestamp placed_at
  }
  PRODUCT {
    uuid id PK
    string sku
    string name
    decimal list_price
  }
  PAYMENT {
    uuid id PK
    uuid order_id FK
    enum method
    enum status
    decimal amount
    timestamp authorized_at
  }
```

## Order State Machine

```mermaid
stateDiagram-v2
  [*] --> Cart
  Cart --> Pending: checkout
  Pending --> Authorized: payment OK
  Pending --> Failed: payment declined
  Authorized --> Picking: warehouse pick
  Picking --> Shipped: handoff to carrier
  Shipped --> Delivered: carrier confirms
  Authorized --> Cancelled: customer cancels
  Picking --> Cancelled: stock-out
  Delivered --> Refunded: refund granted
  Cancelled --> [*]
  Refunded --> [*]
  Failed --> [*]
```

## Deployment Quadrants

| Tier | Stateless | Stateful | Notes |
|------|-----------|----------|-------|
| Edge | CDN, WAF, gateway | — | autoscaled, terraform-managed |
| Compute | Stream workers, REST APIs | — | k8s, HPA on QPS |
| Backbone | — | Kafka, Schema Registry | 3 brokers/zone, mTLS |
| Storage | — | Postgres (primary+replica), ClickHouse, S3 | nightly backups, PITR |
| Search | — | Vector store, OpenSearch | snapshot to S3 daily |

## Service Catalog

| Service | Owner | Tier | RTO | RPO | SLO |
|---------|-------|------|-----|-----|------|
| Gateway | Platform | 0 | 5m | 0 | 99.99% / 100ms p99 |
| Orders | Commerce | 0 | 10m | 0 | 99.95% / 200ms p99 |
| Payments | Commerce | 0 | 10m | 0 | 99.95% / 250ms p99 |
| Inventory | Logistics | 1 | 30m | 1m | 99.9% / 300ms p99 |
| Notifications | Growth | 2 | 60m | 5m | 99.5% / 500ms p99 |
| Catalog | Commerce | 1 | 30m | 1m | 99.9% / 200ms p99 |

## Roadmap

```mermaid
gantt
  dateFormat  YYYY-MM-DD
  title Helios Roadmap
  section Backbone
  Multi-region Kafka         :2026-02-01, 90d
  Schema evolution tooling   :2026-04-01, 60d
  section Process
  Streaming SQL layer        :2026-03-15, 75d
  Feature store              :2026-05-01, 90d
  section Serve
  GraphQL federation         :2026-04-15, 75d
  Personalization API        :2026-06-01, 90d
```

## Closing

Helios is opinionated about a small number of things: events as the spine, schemas as contracts, services as composable units. Everything else is intentionally negotiable.
