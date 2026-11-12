/** @jsxImportSource react */
import * as React from "react";
import { Blocks, Cpu, MessagesSquare, X } from "lucide-react";
import { useDragControls } from "motion/react";

import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { t } from "@/i18n";
import { PanelTab, PanelTabClose, PanelTabItem, PanelTabList } from "@/components/panel-tabs";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

import { EnvironmentView } from "../../aiopc/environment-view";
import { BuiltMcpAppPanel } from "../../apps/built-mcp-app-panel";
import { ArtifactIcon } from "../artifacts/artifact-icon";
import { AppArtifact } from "../../apps/app-artifact";
import { ArtifactPanel } from "../artifacts/artifact-panel";
import { RemoteThreadPanel } from "../remote-threads/remote-thread-panel";
import {
  usePanelTabStore,
  type PanelTab as PanelTabEntry,
  useActivePanelTab,
  useSessionPanelState,
} from "./panel-tab-store";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import type { OpenTarget } from "../artifacts/open-target";
import type { OpenTargetOptions } from "@/lib/target-provider";
import { environmentTab, useSidePanelTabs } from "./use-side-panel-tabs";
import { handlePanelEscape, PanelEmpty } from "./panel-empty";

type SidePanelProps = {
  sessionId: string;
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  onOpenTarget?: (target: OpenTarget, options?: OpenTargetOptions) => void;
  isLocalWorkspace?: boolean;
  onClose: () => void;
  onOpenExtensions?: () => void;
};

const MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT = `# Artifact Markdown Proof

The artifact preview keeps **outside-chat Markdown** readable with inline \`surface renderer\`, a fenced code block, and [OpenWork](https://openworklabs.com).

\`\`\`ts
const surface = "shared markdown primitive";
console.log(surface);
\`\`\`

\`\`\`mermaid
flowchart LR
  ArtifactStart[Artifact Mermaid Start] --> ArtifactFinish[Artifact Mermaid Finish]
\`\`\``;

const STANDALONE_MERMAID_ARTIFACT_CONTENT = `flowchart TD
  StandaloneStart[Standalone Mermaid] --> StandaloneFinish[Rendered artifact]`;

type SidePanelTabProps = {
  tab: PanelTabEntry;
  active: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tab: PanelTabEntry) => void;
};

function SidePanelTab({ tab, active, onSelect, onClose }: SidePanelTabProps) {
  const dragControls = useDragControls();
  const tabRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (active) {
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  return (
    <PanelTabItem
      value={tab.id}
      id={tab.id}
      dragControls={dragControls}
      // Middle-click closes a tab; stopping mousedown keeps it from starting autoscroll.
      onMouseDown={(event: React.MouseEvent<HTMLDivElement>) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event: React.MouseEvent<HTMLDivElement>) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose(tab);
      }}
    >
      <div ref={tabRef} className="relative">
        <PanelTab
          active={active}
          onClick={() => onSelect(tab.id)}
          onPointerDown={(event) => {
            if (event.button === 0) dragControls.start(event);
          }}
          title={tab.label}
          aria-label={`Select tab: ${tab.label}`}
        >
          {(tab.type === "app" || tab.type === "mcp-app") ? <Blocks /> : tab.type === "remote-thread" ? <MessagesSquare /> : tab.type === "environment" ? <Cpu /> : (
            <ArtifactIcon type={tab.preview} />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
        </PanelTab>
        <PanelTabClose
          active={active}
          label={tab.label}
          onClose={() => onClose(tab)}
        />
      </div>
    </PanelTabItem>
  );
}

export function SidePanel({
  sessionId,
  client,
  workspaceId,
  workspaceRoot,
  onOpenTarget,
  isLocalWorkspace,
  onClose,
  onOpenExtensions,
}: SidePanelProps) {
  const { tabs } = useSessionPanelState(sessionId);
  const activeTab = useActivePanelTab(sessionId);

  const { closeTab, selectTab, reorderTabs } = useSidePanelTabs(sessionId);
  // The project's own computer, watched beside the chat.
  const openEnvironmentTab = React.useCallback(() => {
    usePanelTabStore.getState().openTab(sessionId, environmentTab(workspaceRoot));
  }, [sessionId, workspaceRoot]);

  const seedArtifactOverflowControlAction = React.useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_overflow",
      label: "Seed artifact tab overflow eval data",
      description: "Create many markdown artifacts and open them in the right-side artifact tab strip.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      args: [
        { name: "count", type: "number", description: "Number of artifact tabs to create." },
        { name: "longNameLast", type: "boolean", description: "Give the last (active) artifact a very long filename to exercise header truncation." },
      ],
      previewArgs: { count: 18 },
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        let count = 18;
        if (args && typeof args === "object" && "count" in args && typeof args.count === "number") {
          count = Math.max(12, Math.min(30, Math.floor(args.count)));
        }
        const longNameLast = Boolean(args && typeof args === "object" && "longNameLast" in args && args.longNameLast);

        const targets: OpenTarget[] = [];
        const store = usePanelTabStore.getState();

        for (let index = 1; index <= count; index += 1) {
          const padded = String(index).padStart(2, "0");
          const baseName = longNameLast && index === count
            ? `openwork-self-managed-subscription-and-licensing-overview-very-long-${padded}`
            : `overflow-tab-${padded}`;
          const value = `artifacts/${baseName}.md`;
          const label = `${baseName}.md`;
          const content = `# Overflow tab ${padded}\n\nGenerated by the artifact tab overflow eval.\n`;

          await client.writeWorkspaceFile(workspaceId, { path: value, content, baseUpdatedAt: null });

          const target: OpenTarget = {
            id: `file:${value}`,
            kind: "file",
            value,
            name: label,
            preview: "markdown",
            confidence: 100,
            reason: "eval",
            exists: true,
            size: content.length,
          };

          targets.push(target);
          store.openTab(sessionId, {
            id: target.id,
            type: "artifact",
            label: target.name,
            preview: target.preview,
          });
        }

        store.syncTranscriptArtifacts(sessionId, targets);
        store.selectTab(sessionId, targets[targets.length - 1]?.id ?? "");

        return { ok: true, count: targets.length, activeTabId: targets[targets.length - 1]?.id ?? null };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedArtifactOverflowControlAction);

  const seedMarkdownPrimitiveArtifactControlAction = React.useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.markdown_primitive.seed_artifact",
      label: "Seed markdown primitive artifact proof",
      description: "Create a deterministic markdown artifact and open it in the preview panel.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        const standalone = Boolean(args && typeof args === "object" && "standalone" in args && args.standalone);
        const value = standalone ? "artifacts/standalone-mermaid-proof.mmd" : "artifacts/markdown-primitive-proof.md";
        const name = standalone ? "standalone-mermaid-proof.mmd" : "markdown-primitive-proof.md";
        const content = standalone ? STANDALONE_MERMAID_ARTIFACT_CONTENT : MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT;
        await client.writeWorkspaceFile(workspaceId, {
          path: value,
          content,
          baseUpdatedAt: null,
        });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name,
          preview: "markdown",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: content.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id, path: value };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedMarkdownPrimitiveArtifactControlAction);

  const seedPdfArtifactControlAction = React.useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_pdf",
      label: "Seed a PDF artifact",
      description: "Write a small valid PDF and open it as an artifact tab to verify inline PDF rendering.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async () => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        // Minimal single-page PDF that draws "OpenWork PDF" — base64 encoded.
        const pdfBase64 =
          "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMTQ0XS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgo3MiA3MCBUZAooT3BlbldvcmsgUERGKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzEyIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNDA2CiUlRU9G";
        const binary = atob(pdfBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

        const value = "artifacts/sample-document.pdf";
        await client.writeWorkspaceBinaryFile(workspaceId, { path: value, data: bytes.buffer, baseUpdatedAt: null });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name: "sample-document.pdf",
          preview: "pdf",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: bytes.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedPdfArtifactControlAction);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || tabs.length < 2) {
        return;
      }

      const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1;
      if (activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const offset = event.shiftKey ? -1 : 1;
      selectTab(tabs[(activeIndex + offset + tabs.length) % tabs.length].id);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, selectTab, tabs]);

  return (
    <TooltipProvider delay={1000}>
      <div
        className="flex h-full flex-col"
        onKeyDownCapture={(event) => {
          if (!handlePanelEscape(event.key, onClose)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {!(tabs.length === 1 && activeTab?.type === "mcp-app") ? <div className="shrink-0 border-b border-border bg-background mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
          <div className="flex h-10 items-center gap-1 border-b border-border/60 px-2">
            <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
              <PanelTabList
                values={tabs.map((tab) => tab.id)}
                onReorder={reorderTabs}
              >
                {tabs.map((tab) => (
                  <SidePanelTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTab?.id}
                    onSelect={selectTab}
                    onClose={closeTab}
                  />
                ))}
              </PanelTabList>
            </div>
            {!activeTab ? <span className="sr-only">Panel destinations</span> : null}
            {!activeTab ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label={t("aiopc.browser.close_panel")}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div> : null}
        {!activeTab ? (
          <PanelEmpty
            onOpenExtensions={onOpenExtensions}
            onOpenEnvironment={workspaceRoot ? openEnvironmentTab : undefined}
          />
        ) : null}
        {activeTab?.type === "mcp-app" ? (
          <BuiltMcpAppPanel key={activeTab.id} tab={activeTab} onClose={onClose} />
        ) : activeTab?.type === "environment" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <EnvironmentView key={activeTab.id} workspaceRoot={activeTab.workspaceRoot} />
          </div>
        ) : activeTab?.type === "remote-thread" ? (
          <div className="min-h-0 flex-1 overflow-hidden"><RemoteThreadPanel key={activeTab.id} tab={activeTab} /></div>
        ) : activeTab?.type === "app" ? (
          <div className="min-h-0 flex-1 overflow-hidden"><AppArtifact key={activeTab.id} appId={activeTab.appId} revisionId={activeTab.revisionId} receiptId={activeTab.receiptId} onClose={onClose} /></div>
        ) : activeTab?.type === "artifact" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <ArtifactPanel
              sessionId={sessionId}
              tab={activeTab}
              client={client}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              onOpenTarget={onOpenTarget}
              isLocalWorkspace={isLocalWorkspace}
              onClose={onClose}
            />
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
