---
name: typescript
description: TypeScript strict patterns and best practices. Trigger: When writing TypeScript code - types, interfaces, generics.
---

## Const Types Pattern (REQUIRED)

```typescript
// ✅ ALWAYS: Create const object first, then extract type
const STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  PENDING: "pending",
} as const;

type Status = (typeof STATUS)[keyof typeof STATUS];

// ❌ NEVER: Direct union types
type Status = "active" | "inactive" | "pending";
```

**Why?** Single source of truth, runtime values, autocomplete, easier refactoring.

## Flat Interfaces (REQUIRED)

```typescript
// ✅ ALWAYS: One level depth, nested objects → dedicated interface
interface UserAddress {
  street: string;
  city: string;
}

interface User {
  id: string;
  name: string;
  address: UserAddress;  // Reference, not inline
}

interface Admin extends User {
  permissions: string[];
}

// ❌ NEVER: Inline nested objects
interface User {
  address: { street: string; city: string };  // NO!
}
```

## Never Use `any`

```typescript
// ✅ Use unknown for truly unknown types
function parse(input: unknown): User {
  if (isUser(input)) return input;
  throw new Error("Invalid input");
}

// ✅ Use generics for flexible types
function first<T>(arr: T[]): T | undefined {
  return arr[0];
}

// ❌ NEVER
function parse(input: any): any { }
```

## No Nested Ternaries (REQUIRED)

```typescript
// ❌ NEVER: nested ternaries — unreadable, flagged by SonarCloud/ESLint
const color = state === "available" ? "green" : state === "busy" ? "red" : "yellow";

// ✅ Lookup map keyed by the discriminant — single source of truth, extensible
const STATE_CONFIG = {
  available: { color: "green", label: "Disponible" },
  busy: { color: "red", label: "Ocupado" },
  lead: { color: "yellow", label: "No reservable aún" },
} as const;

const { color, label } = STATE_CONFIG[state];

// ✅ When the value is computed (not a direct key), use early returns
function slotState(available: boolean, hasReasons: boolean) {
  if (available) return "available";
  if (hasReasons) return "busy";
  return "lead";
}

// ✅ In JSX, prefer independent && blocks over a chained ternary
{loading && <Loader />}
{!loading && items.length === 0 && <Empty />}
{!loading && items.length > 0 && <List />}
```

**Why?** A nested ternary is a `switch` in disguise — a lookup map or early returns reads top-to-bottom, adds cases without re-nesting, and keeps the config in one place. A single (non-nested) ternary is fine; nesting is the smell.

## Utility Types

```typescript
Pick<User, "id" | "name">     // Select fields
Omit<User, "id">              // Exclude fields
Partial<User>                 // All optional
Required<User>                // All required
Readonly<User>                // All readonly
Record<string, User>          // Object type
Extract<Union, "a" | "b">     // Extract from union
Exclude<Union, "a">           // Exclude from union
NonNullable<T | null>         // Remove null/undefined
ReturnType<typeof fn>         // Function return type
Parameters<typeof fn>         // Function params tuple
```

## Type Guards

```typescript
function isUser(value: unknown): value is User {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value
  );
}
```

## Import Types

```typescript
import type { User } from "./types";
import { createUser, type Config } from "./utils";
```

## Keywords
typescript, ts, types, interfaces, generics, strict mode, utility types, nested ternary, lookup map, early returns
