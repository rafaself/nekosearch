### `ToolAnnotations`

```typescript
interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
```

Additional properties describing a Tool to clients. All properties in
`ToolAnnotations` are hints. They are not guaranteed to provide a faithful
description of tool behavior, including descriptive properties such as `title`.
Clients should never make tool use decisions based on `ToolAnnotations` received
from untrusted servers.

This field reference is excerpted from the official
[2025-11-25 schema reference](https://modelcontextprotocol.io/specification/2025-11-25/schema.md#toolannotations).

- `title?: string`: A human-readable title for the tool.
- `readOnlyHint?: boolean`: If true, the tool does not modify its environment.
  Default: `false`.
- `destructiveHint?: boolean`: If true, the tool may perform destructive
  updates to its environment. If false, the tool performs only additive
  updates. This property is meaningful only when `readOnlyHint == false`.
  Default: `true`.
- `idempotentHint?: boolean`: If true, calling the tool repeatedly with the
  same arguments will have no additional effect on its environment. This
  property is meaningful only when `readOnlyHint == false`. Default: `false`.
- `openWorldHint?: boolean`: If true, the tool may interact with an open world
  of external entities. If false, its domain of interaction is closed. For
  example, the world of a web search tool is open, while that of a memory tool
  is not. Default: `true`.
