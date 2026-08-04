import { describe, expect, it } from "vitest";
import { renderBridgeVizHtml, type MergedGraph } from "./bridge-viz.js";

function twoRepoGraph(): MergedGraph {
  return {
    nodes: [
      { id: "repo-a::foo", repo: "repo-a", label: "foo()", source_file: "src/foo.ts" },
      { id: "repo-a::unrelated", repo: "repo-a", label: "unrelated()", source_file: "src/unrelated.ts" },
      { id: "repo-b::bar", repo: "repo-b", label: "bar()", source_file: "src/bar.ts" },
    ],
    links: [
      {
        source: "repo-a::foo",
        target: "repo-b::bar",
        relation: "http_call",
        _origin: "bridge",
        context: "GET /bar",
        source_file: "repo-a/src/foo.ts",
        source_location: "L3 -> repo-b/src/bar.ts:L10",
      },
      // A non-bridge link — must never leak into the viz.
      { source: "repo-a::foo", target: "repo-a::unrelated", relation: "calls" },
    ],
  };
}

describe("renderBridgeVizHtml", () => {
  it("embeds the bridge nodes/edges and a legend with per-repo counts", () => {
    const html = renderBridgeVizHtml(twoRepoGraph(), { workspaceName: "bonum" });

    expect(html).toContain("repo-a::foo");
    expect(html).toContain("repo-b::bar");
    expect(html).toContain('"relation":"http_call"');
    expect(html).toContain('"context":"GET /bar"');
    // The unrelated repo-a node (no bridge edge) never made it into the viz nodes.
    expect(html).not.toContain("repo-a::unrelated");
    // Legend: one item per repo, with node counts.
    expect(html).toContain('"repo":"repo-a"');
    expect(html).toContain('"repo":"repo-b"');
    expect(html).toContain('"count":1');
    expect(html).toContain("bonum — bridge graph");
  });

  it("escapes a malicious label so no </script> ever appears in the embedded data", () => {
    const malicious = "</script><script>alert(1)</script>";
    const graph: MergedGraph = {
      nodes: [
        { id: "repo-a::x", repo: "repo-a", label: malicious },
        { id: "repo-b::y", repo: "repo-b", label: "y()" },
      ],
      links: [{ source: "repo-a::x", target: "repo-b::y", relation: "http_call", _origin: "bridge" }],
    };

    const html = renderBridgeVizHtml(graph, { workspaceName: "bonum" });

    expect(html).not.toContain("</script><script>alert(1)</script>");
    // The escaped form must still be present — data isn't silently dropped,
    // every "<" (not just "</script>") is neutralized to "<".
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
  });

  it("renders an explicit empty message when there are no bridge edges", () => {
    const graph: MergedGraph = {
      nodes: [{ id: "repo-a::foo", repo: "repo-a", label: "foo()" }],
      links: [{ source: "repo-a::foo", target: "repo-a::foo", relation: "calls" }],
    };

    const html = renderBridgeVizHtml(graph, { workspaceName: "bonum" });

    expect(html).toContain("sin contratos cross-repo detectados");
    expect(html).toContain('"empty":true');
  });
});
