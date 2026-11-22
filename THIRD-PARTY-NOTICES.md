# Third-party notices

NekoSearch does not bundle NestJS documentation indexes. If you choose to run
`nekosearch add nestjs@11` or `nekosearch add nestjs@12`, it fetches supported
Markdown files from the official
[NestJS documentation repository](https://github.com/nestjs/docs.nestjs.com)
and builds a local snapshot. The source is MIT licensed; license texts and
copyright notices are included in `licenses/`.

The bundled `mcp@2025-11-25` snapshot includes the official versioned
[Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md)
and
[Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources.md)
pages, plus the `ToolAnnotations` section of the official
[schema reference](https://modelcontextprotocol.io/specification/2025-11-25/schema.md#toolannotations).
These pages are from the
[Model Context Protocol repository](https://github.com/modelcontextprotocol/modelcontextprotocol)
tag `2025-11-25`. That tag's `LICENSE` identifies the source as MIT licensed;
the license text and copyright notice are included in
`licenses/mcp-protocol-2025-11-25-LICENSE`.

The overview, architecture, lifecycle, transports, and combined
tools/resources/prompts pages in `apps/nekosearch/content/mcp-protocol/` are
NekoSearch-authored summaries. They are not official MCP documentation. This
snapshot is reference documentation for the protocol, not the NekoSearch MCP
server.

This project is independent and is not affiliated with or endorsed by NestJS or
the Model Context Protocol project or its maintainers.
