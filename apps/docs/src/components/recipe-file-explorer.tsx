"use client";

import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "fumadocs-ui/components/ui/tabs";
import type { LucideIcon } from "lucide-react";
import { FileCode2, FileJson, FileText, FileType2, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";

export type RecipeFileExplorerFile = {
  path: string;
};

type TreeNode =
  | {
      children: TreeNode[];
      kind: "folder";
      name: string;
      path: string;
    }
  | {
      kind: "file";
      name: string;
      path: string;
    };

type TreeNodesProps = {
  nodes: TreeNode[];
};

const fileIconsBySuffix = new Map<string, LucideIcon>([
  [".d.ts", FileCode2],
  [".ts", FileCode2],
  [".json", FileJson],
  [".md", FileText],
  [".mdx", FileText],
  [".yaml", Workflow],
  [".yml", Workflow],
]);

export function RecipeFileExplorer({
  children,
  files,
}: {
  children: ReactNode;
  files: RecipeFileExplorerFile[];
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const defaultValue = files[0]?.path;

  if (!defaultValue) {
    return null;
  }

  return (
    <Tabs
      defaultValue={defaultValue}
      className="recipe-file-explorer not-prose my-6 overflow-hidden rounded-xl border bg-fd-card shadow-sm"
    >
      <div className="grid min-h-[420px] lg:grid-cols-[minmax(14rem,0.34fr)_minmax(0,1fr)]">
        <aside className="border-b bg-fd-card lg:border-e lg:border-b-0">
          <TabsList className="block h-auto bg-transparent p-0" aria-label="Recipe files">
            <Files className="flex flex-col gap-1 rounded-none border-0 bg-transparent">
              <TreeNodes nodes={tree} />
            </Files>
          </TabsList>
        </aside>
        <div className="min-w-0 bg-fd-card">{children}</div>
      </div>
    </Tabs>
  );
}

export function RecipeFilePane({ children, path }: { children: ReactNode; path: string }) {
  return (
    <TabsContent value={path} className="m-0 min-w-0 outline-none" data-recipe-file-content="">
      {children}
    </TabsContent>
  );
}

function TreeNodes({ nodes }: TreeNodesProps) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "folder") {
          return (
            <Folder
              key={node.path}
              name={node.name}
              defaultOpen
              className="flex flex-col gap-1 [&>[data-state]>div]:gap-1"
            >
              <TreeNodes nodes={node.children} />
            </Folder>
          );
        }

        return (
          <TabsTrigger key={node.path} value={node.path} asChild>
            <File
              name={node.name}
              icon={fileIcon(node.path)}
              className={classNames(
                "w-full cursor-pointer text-fd-muted-foreground",
                "data-[state=active]:bg-fd-primary/10 data-[state=active]:text-fd-primary data-[state=active]:ring-1 data-[state=active]:ring-fd-primary/25",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring",
              )}
            />
          </TabsTrigger>
        );
      })}
    </>
  );
}

function buildTree(files: RecipeFileExplorerFile[]): TreeNode[] {
  const tree: TreeNode[] = [];
  const folders = new Map<string, Extract<TreeNode, { kind: "folder" }>>();

  for (const file of uniqueFiles(files)) {
    addFileToTree(tree, folders, file);
  }

  return tree;
}

function uniqueFiles(files: RecipeFileExplorerFile[]): RecipeFileExplorerFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const isNew = !seen.has(file.path);
    seen.add(file.path);
    return isNew;
  });
}

function addFileToTree(
  root: TreeNode[],
  folders: Map<string, Extract<TreeNode, { kind: "folder" }>>,
  file: RecipeFileExplorerFile,
): void {
  const parts = file.path.split("/").filter(Boolean);
  let siblings = root;
  let currentPath = "";

  for (const [index, part] of parts.entries()) {
    const pathSegment = currentPath ? `${currentPath}/${part}` : part;
    if (index === parts.length - 1) {
      siblings.push({ kind: "file", name: part, path: file.path });
    } else {
      const folder = folderNode(folders, siblings, part, pathSegment);
      siblings = folder.children;
      currentPath = pathSegment;
    }
  }
}

function folderNode(
  folders: Map<string, Extract<TreeNode, { kind: "folder" }>>,
  siblings: TreeNode[],
  name: string,
  nodePath: string,
): Extract<TreeNode, { kind: "folder" }> {
  const existing = folders.get(nodePath);
  if (existing) {
    return existing;
  }

  const folder: Extract<TreeNode, { kind: "folder" }> = {
    children: [],
    kind: "folder",
    name,
    path: nodePath,
  };
  folders.set(nodePath, folder);
  siblings.push(folder);
  return folder;
}

function fileIcon(path: string): ReactNode {
  const Icon = fileIconsBySuffix.get(fileSuffix(path)) ?? FileType2;

  return <Icon className="size-4" aria-hidden="true" />;
}

function fileSuffix(path: string): string {
  return path.match(/(?:\.d\.ts|\.[^.]+)$/)?.[0] ?? "";
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}
