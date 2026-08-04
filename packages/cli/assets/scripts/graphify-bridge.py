#!/usr/bin/env python3
"""graphify-bridge — inject cross-repo edges into a graphify merged graph.

Generic: works on any workspace. Detects contracts between repos and
materializes them as edges so `graphify path/query` can traverse repo
boundaries:

  1. HTTP bridge   — client calls (axios.<method>) matched against server
                     routes (express router.<method> with full mount-chain
                     prefixes, NestJS decorators) by HTTP method + longest
                     path-segment suffix overlap. Ties -> reported, not guessed.
  2. Constant bridge — snake_case string literals (upper or lower) shared
                     between repos (e.g. mail template wire values flowing
                     through a message queue).

Usage:
  graphify-bridge --graph merged-graph.json REPO_DIR [REPO_DIR ...]

Repo node-id prefixes are the directory basenames (same rule graphify
merge-graphs uses). Bridge edges carry _origin="bridge" and are stripped on
re-run, so the command is idempotent.
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

SKIP_DIRS = {"node_modules", "dist", "build", "coverage", ".git", "graphify-out",
             ".next", "out", "__pycache__", ".claude"}
CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs"}
HTTP_METHODS = "get|post|put|patch|delete"


def code_files(repo: Path):
    for p in repo.rglob("*"):
        if p.suffix not in CODE_EXT or not p.is_file():
            continue
        parts = set(p.relative_to(repo).parts)
        if parts & SKIP_DIRS:
            continue
        rel = str(p.relative_to(repo))
        if re.search(r"(\.test\.|\.spec\.|__tests__|/tests?/|^tests?/)", rel):
            continue
        yield p, rel


def enclosing_symbol(lines, idx):
    """Nearest enclosing top-level declaration or class method above idx."""
    pat_top = re.compile(r"^(?:export\s+)?(?:default\s+)?(?:const|let|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)")
    pat_method = re.compile(r"^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(")
    method = None
    for i in range(idx, -1, -1):
        m = pat_top.match(lines[i])
        if m:
            return method or m.group(1)  # method wins if we passed one (class case)
        if method is None:
            mm = pat_method.match(lines[i])
            if mm and mm.group(1) not in ("if", "for", "while", "switch", "return", "catch", "constructor"):
                method = mm.group(1)
    return method


def norm_segments(raw_path):
    """'/cancel/${id}' -> ['cancel', ':p']. Interpolations become ':p'."""
    raw = re.sub(r"^https?://[^/]+", "", raw_path.strip())
    segs = []
    for s in raw.split("/"):
        s = s.strip()
        if not s:
            continue
        if re.fullmatch(r"\$\{[^}]*\}|:[\w]+", s) or "${" in s:
            segs.append(":p")
        else:
            segs.append(s.lower())
    return segs


# ---------- client side ----------

def base_var_segments(text):
    """Map base-URL variable name -> literal path segments in its initializer.
    Catches `const route = VITE_API_X + 'session'` and template-literal forms."""
    out = {}
    decl_re = re.compile(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)")
    for m in decl_re.finditer(text):
        name, rhs = m.group(1), m.group(2)
        if not re.search(r"(env|URL|API|BASE|HOST)", rhs, re.I) and not re.search(r"(url|api|base)$", name, re.I):
            continue
        lits = re.findall(r"['\"`]([^'\"`,]+)['\"`]", rhs)
        segs = []
        for lit in lits:
            segs += [s for s in norm_segments(lit) if s != ":p"]
        if segs:
            out[name] = segs
    return out


def extract_http_clients(repo: Path, repo_name: str):
    out = []
    call_re = re.compile(r"\baxios\s*\.\s*(" + HTTP_METHODS + r")\s*\(\s*(`[^`]*`|'[^']*'|\"[^\"]*\")", re.I)
    for p, rel in code_files(repo):
        try:
            text = p.read_text(errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        bases = base_var_segments(text)
        for m in call_re.finditer(text):
            method = m.group(1).upper()
            raw = m.group(2)[1:-1]
            base_prefix = []
            bm = re.match(r"\s*\$\{\s*([A-Za-z_$][\w$]*)", raw)
            if bm and bm.group(1) in bases:
                base_prefix = bases[bm.group(1)]
            segs = norm_segments(raw)
            while segs and segs[0] == ":p" and not base_prefix:
                segs.pop(0)  # unknown interpolated base
            if segs and segs[0] == ":p" and base_prefix:
                segs = base_prefix + segs[1:]
            if not segs:
                continue
            line_idx = text[: m.start()].count("\n")
            out.append({"repo": repo_name, "file": rel, "line": line_idx + 1,
                        "symbol": enclosing_symbol(lines, line_idx),
                        "method": method, "segments": segs, "raw": raw})
    return out


# ---------- server side ----------

def resolve_import(repo: Path, from_file: str, spec: str):
    """'./sessionRoutes' relative to from_file -> repo-relative file, or None."""
    if not spec.startswith("."):
        return None
    root = repo.resolve()
    base = ((root / from_file).parent / spec).resolve()
    for cand in (base, *(base.with_suffix(ext) for ext in CODE_EXT),
                 *(base / f"index{ext}" for ext in CODE_EXT)):
        try:
            if cand.is_file():
                return str(cand.relative_to(root))
        except (OSError, ValueError):
            continue
    return None


def mount_prefixes(repo: Path):
    """Follow app.use('/x', ident) / router.use('/y', ident) chains ->
    {route_file: [prefix segments]}."""
    mounts = []  # (host_file, prefix_segs, target_file)
    for p, rel in code_files(repo):
        try:
            text = p.read_text(errors="replace")
        except OSError:
            continue
        imports = {}
        for im in re.finditer(r"import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,[^;]*)?\s+from\s+['\"]([^'\"]+)['\"]", text):
            imports[im.group(1)] = im.group(2)
        for um in re.finditer(r"\b(?:app|router)\s*\.\s*use\(\s*['\"`]([^'\"`]+)['\"`]\s*,\s*([A-Za-z_$][\w$]*)", text):
            prefix, ident = um.group(1), um.group(2)
            spec = imports.get(ident)
            target = resolve_import(repo, rel, spec) if spec else None
            if target:
                mounts.append((rel, norm_segments(prefix), target))
    prefixes = {}
    for _ in range(5):  # chain: app.ts -> routes/index.ts -> sessionRoutes.ts
        changed = False
        for host, segs, target in mounts:
            full = prefixes.get(host, []) + segs
            if prefixes.get(target) != full:
                prefixes[target] = full
                changed = True
        if not changed:
            break
    return prefixes


def extract_http_routes(repo: Path, repo_name: str):
    out = []
    prefixes = mount_prefixes(repo)
    express_re = re.compile(
        r"\b(?:router|app)\s*\.\s*(" + HTTP_METHODS + r")\s*\(\s*(['\"`])([^'\"`]+)\2([^;]*)", re.I)
    nest_re = re.compile(r"@(Get|Post|Put|Patch|Delete)\(\s*(?:(['\"`])([^'\"`]*)\2)?\s*\)")
    ctrl_prefix_re = re.compile(r"@Controller\(\s*(?:(['\"`])([^'\"`]*)\1)?\s*\)")
    handler_re = re.compile(r"[\w$]+\s*\.\s*([A-Za-z_$][\w$]*)\s*\(")

    for p, rel in code_files(repo):
        try:
            text = p.read_text(errors="replace")
        except OSError:
            continue
        prefix = prefixes.get(rel, [])
        for m in express_re.finditer(text):
            method, path, tail = m.group(1).upper(), m.group(3), m.group(4)
            hm = handler_re.search(tail)
            line_idx = text[: m.start()].count("\n")
            out.append({"repo": repo_name, "file": rel, "line": line_idx + 1,
                        "symbol": hm.group(1) if hm else None,
                        "method": method, "segments": prefix + norm_segments(path),
                        "raw": path})
        cp = ctrl_prefix_re.search(text)
        nest_prefix = norm_segments(cp.group(2)) if cp and cp.group(2) else []
        for m in nest_re.finditer(text):
            method = m.group(1).upper()
            segs = nest_prefix + norm_segments(m.group(3) or "")
            mm = re.search(r"(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(", text[m.end():])
            line_idx = text[: m.start()].count("\n")
            out.append({"repo": repo_name, "file": rel, "line": line_idx + 1,
                        "symbol": mm.group(1) if mm else None,
                        "method": method, "segments": segs, "raw": m.group(3) or ""})
    return out


# ---------- constants ----------

CONST_NOISE = {"utf_8", "no_content", "not_found", "bad_request", "content_type",
               "application_json", "internal_server_error", "node_modules",
               "access_token", "refresh_token", "created_at", "updated_at"}

def extract_constants(repo: Path, repo_name: str):
    """snake_case string literals (UPPER or lower) -> {const: {file: count}}."""
    const_re = re.compile(r"['\"]([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)['\"]")
    found = defaultdict(lambda: defaultdict(int))
    for p, rel in code_files(repo):
        try:
            text = p.read_text(errors="replace")
        except OSError:
            continue
        for m in const_re.finditer(text):
            c = m.group(1)
            if len(c) >= 8 and c.lower() not in CONST_NOISE and (c.isupper() or c.islower()):
                found[c][rel] += 1
    return {"repo": repo_name, "constants": found}


# ---------- node resolution ----------

class NodeIndex:
    def __init__(self, nodes):
        self.by_repo_file = defaultdict(list)
        for n in nodes:
            if "repo" in n and "source_file" in n:
                self.by_repo_file[(n["repo"], n["source_file"])].append(n)

    def resolve(self, repo, file, symbol):
        cands = self.by_repo_file.get((repo, file), [])
        if not cands:
            return None
        if symbol:
            sym = symbol.lower()
            def norm(n):
                return n.get("norm_label", "").removesuffix("()")
            exact = [n for n in cands if norm(n) == sym]
            if exact:
                return exact[0]["id"]
            partial = [n for n in cands if norm(n).endswith("_" + sym) or norm(n).endswith("." + sym)]
            if partial:
                return partial[0]["id"]
        return min(cands, key=lambda n: len(n.get("local_id", n["id"])))["id"]


# ---------- bridging ----------

def suffix_overlap(a, b):
    k = 0
    while k < len(a) and k < len(b) and a[-1 - k] == b[-1 - k]:
        k += 1
    return k


def bridge_http(clients, routes, idx):
    edges, unmatched, ambiguous = [], [], []
    routes_by_method = defaultdict(list)
    for r in routes:
        if r["segments"]:
            routes_by_method[r["method"]].append(r)
    for c in clients:
        scored = []
        for r in routes_by_method.get(c["method"], []):
            if r["repo"] == c["repo"]:
                continue
            k = suffix_overlap(c["segments"], r["segments"])
            if k >= min(2, len(c["segments"])) and k >= len(r["segments"]) - len(r.get("prefix", [])) - 3:
                scored.append((k, r))
        if not scored:
            unmatched.append(c)
            continue
        best_k = max(k for k, _ in scored)
        best = [r for k, r in scored if k == best_k]
        targets = {(r["repo"], r["file"], r["line"]) for r in best}
        if len(targets) > 1:
            ambiguous.append((c, best))
            continue
        r = best[0]
        s = idx.resolve(c["repo"], c["file"], c["symbol"])
        t = idx.resolve(r["repo"], r["file"], r["symbol"])
        if s and t:
            edges.append({
                "source": s, "target": t, "relation": "http_call",
                "context": f"{c['method']} /{'/'.join(r['segments'])}",
                "confidence": "BRIDGED", "confidence_score": 0.9, "weight": 1.0,
                "_origin": "bridge",
                "source_file": f"{c['repo']}/{c['file']}",
                "source_location": f"L{c['line']} -> {r['repo']}/{r['file']}:L{r['line']}",
            })
    return edges, unmatched, ambiguous


def bridge_constants(const_sets, idx, max_files_per_repo=8):
    edges = []
    all_consts = defaultdict(dict)
    for cs in const_sets:
        for c, files in cs["constants"].items():
            all_consts[c][cs["repo"]] = files
    for c, per_repo in sorted(all_consts.items()):
        if len(per_repo) < 2:
            continue
        if any(len(files) > max_files_per_repo for files in per_repo.values()):
            continue
        anchors = {}
        for repo, files in per_repo.items():
            file = max(files, key=files.get)
            nid = idx.resolve(repo, file, None)
            if nid:
                anchors[repo] = (nid, file)
        rs = sorted(anchors)
        for i in range(len(rs)):
            for j in range(i + 1, len(rs)):
                (sa, fa), (ta, fb) = anchors[rs[i]], anchors[rs[j]]
                edges.append({
                    "source": sa, "target": ta, "relation": "shared_constant",
                    "context": c, "confidence": "BRIDGED_HEURISTIC",
                    "confidence_score": 0.6, "weight": 0.5, "_origin": "bridge",
                    "source_file": f"{rs[i]}/{fa}",
                    "source_location": f"<-> {rs[j]}/{fb}",
                })
    return edges


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--graph", required=True, help="merged-graph.json to enrich in place")
    ap.add_argument("repos", nargs="+", help="repo directories (basename = node prefix)")
    ap.add_argument("--no-constants", action="store_true", help="skip the heuristic constant bridge")
    ap.add_argument("--report", help="write unmatched/ambiguous report (markdown)")
    args = ap.parse_args()

    gpath = Path(args.graph)
    g = json.loads(gpath.read_text())
    before = len(g["links"])
    g["links"] = [l for l in g["links"] if l.get("_origin") != "bridge"]
    stripped = before - len(g["links"])
    idx = NodeIndex(g["nodes"])

    clients, routes, const_sets = [], [], []
    for rd in args.repos:
        repo = Path(rd).resolve()
        clients += extract_http_clients(repo, repo.name)
        routes += extract_http_routes(repo, repo.name)
        if not args.no_constants:
            const_sets.append(extract_constants(repo, repo.name))

    http_edges, unmatched, ambiguous = bridge_http(clients, routes, idx)
    const_edges = bridge_constants(const_sets, idx) if const_sets else []

    seen, new_edges = set(), []
    for e in http_edges + const_edges:
        key = (e["source"], e["target"], e["relation"], e.get("context"))
        if key not in seen:
            seen.add(key)
            new_edges.append(e)
    g["links"] += new_edges
    gpath.write_text(json.dumps(g))

    print(f"clients={len(clients)} routes={len(routes)} | "
          f"http_edges={len(http_edges)} const_edges={len(const_edges)} "
          f"(dedup->{len(new_edges)}) | ambiguous={len(ambiguous)} | stripped_previous={stripped}")
    print(f"unmatched client calls (no cross-repo route): {len(unmatched)}")
    if args.report:
        lines = ["# graphify-bridge report", "",
                 f"- clients: {len(clients)}  routes: {len(routes)}",
                 f"- http edges: {len(http_edges)}  constant edges: {len(const_edges)}",
                 f"- ambiguous (skipped, need manual review): {len(ambiguous)}", "",
                 "## Ambiguous client calls (several routes tie)", ""]
        for c, best in ambiguous:
            opts = "; ".join(f"{r['repo']}/{r['file']}:{r['line']}" for r in best[:4])
            lines.append(f"- `{c['method']} {c['raw']}` — {c['repo']}/{c['file']}:{c['line']} -> {opts}")
        lines += ["", "## Unmatched client calls (dead endpoint, same-repo, or repo outside merge)", ""]
        for c in unmatched:
            lines.append(f"- `{c['method']} {c['raw']}` — {c['repo']}/{c['file']}:{c['line']} ({c['symbol'] or '?'})")
        Path(args.report).write_text("\n".join(lines) + "\n")
        print(f"report -> {args.report}")


if __name__ == "__main__":
    sys.exit(main())
