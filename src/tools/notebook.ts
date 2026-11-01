import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { abs, err, ok, type Workspace } from "./util";

type Cell = {
  id?: string;
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata?: object;
  outputs?: Output[];
  execution_count?: number | null;
};
type Output = {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
};
type Notebook = { cells: Cell[]; nbformat?: number; nbformat_minor?: number };
type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const join = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join("") : s ?? "");
const cellId = (cell: Cell, index: number) => cell.id ?? `cell-${index}`;
const ANSI = /\x1b\[[0-9;]*m/g;

/** How Read shows a notebook: every cell with its id, then its outputs. Images come back as images. */
export function renderNotebook(text: string): Block[] {
  const blocks: Block[] = [];
  let buffer = "";
  JSON.parse(text).cells.forEach((cell: Cell, i: number) => {
    buffer += `<cell id="${cellId(cell, i)}" type="${cell.cell_type}">\n${join(cell.source)}\n</cell>\n`;
    for (const out of cell.outputs ?? []) {
      if (out.output_type === "stream") buffer += `<output>\n${join(out.text)}</output>\n`;
      if (out.output_type === "error") buffer += `<output>\n${out.ename}: ${out.evalue}\n${(out.traceback ?? []).join("\n").replace(ANSI, "")}\n</output>\n`;
      if (!out.data) continue;
      const image = Object.keys(out.data).find((k) => k.startsWith("image/") && k !== "image/svg+xml");
      if (image) {
        blocks.push({ type: "text", text: buffer });
        blocks.push({ type: "image", data: join(out.data[image]).replace(/\s/g, ""), mimeType: image });
        buffer = "";
      } else if (out.data["text/plain"]) {
        buffer += `<output>\n${join(out.data["text/plain"])}\n</output>\n`;
      }
    }
  });
  if (buffer) blocks.push({ type: "text", text: buffer });
  return blocks;
}

/** Notebook sources are conventionally stored as a list of lines, each keeping its newline. */
const lines = (source: string) => source.split(/(?<=\n)/);

export const notebookEdit = (ws: Workspace) => tool(
  "NotebookEdit",
  `Replaces, inserts or deletes a cell in a Jupyter notebook (.ipynb file) on the user's local filesystem.

- Read the notebook first to see the cell ids
- edit_mode "replace" (default) replaces the source of the cell with cell_id; a code cell's outputs are cleared
- edit_mode "insert" adds a new cell after cell_id, or at the beginning when cell_id is omitted; cell_type is required
- edit_mode "delete" removes the cell with cell_id`,
  {
    notebook_path: z.string().describe("The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)"),
    cell_id: z.string().optional().describe("The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified."),
    new_source: z.string().describe("The new source for the cell"),
    cell_type: z.enum(["code", "markdown"]).optional().describe("The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required."),
    edit_mode: z.enum(["replace", "insert", "delete"]).optional().describe("The type of edit to make (replace, insert, delete). Defaults to replace."),
  },
  async ({ notebook_path, cell_id, new_source, cell_type, edit_mode = "replace" }) => {
    const path = abs(ws, notebook_path);
    if (!path.endsWith(".ipynb")) return err("File must be a Jupyter notebook (.ipynb file). For editing other file types, use the Edit tool.");
    const file = Bun.file(path);
    if (!(await file.exists())) return err(`Notebook file does not exist: ${path}`);

    let nb: Notebook;
    try {
      nb = JSON.parse(await file.text());
    } catch {
      return err("Notebook is not valid JSON.");
    }
    let index = -1;
    if (cell_id !== undefined) {
      index = nb.cells.findIndex((c, i) => cellId(c, i) === cell_id);
      if (index === -1) return err(`Cell with ID "${cell_id}" not found in notebook.`);
    } else if (edit_mode !== "insert") {
      return err(`cell_id is required for edit_mode "${edit_mode}".`);
    }

    if (edit_mode === "delete") {
      nb.cells.splice(index, 1);
    } else if (edit_mode === "insert") {
      if (!cell_type) return err('cell_type is required when using edit_mode "insert".');
      const withIds = (nb.nbformat ?? 4) > 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) >= 5);
      const cell: Cell = {
        ...(withIds ? { id: crypto.randomUUID().slice(0, 8) } : {}),
        cell_type,
        metadata: {},
        source: lines(new_source),
        ...(cell_type === "code" ? { execution_count: null, outputs: [] } : {}),
      };
      nb.cells.splice(index + 1, 0, cell);
      index += 1;
    } else {
      const cell = nb.cells[index]!;
      cell.source = lines(new_source);
      if (cell_type) cell.cell_type = cell_type;
      if (cell.cell_type === "code") {
        cell.execution_count = null;
        cell.outputs = [];
      } else {
        delete cell.execution_count;
        delete cell.outputs;
      }
    }

    await Bun.write(path, `${JSON.stringify(nb, null, 1)}\n`);
    const id = edit_mode === "delete" ? cell_id : cellId(nb.cells[index]!, index);
    const verb = { replace: "Updated", insert: "Inserted", delete: "Deleted" }[edit_mode];
    return ok(`${verb} cell ${id} in ${path}`);
  },
);
