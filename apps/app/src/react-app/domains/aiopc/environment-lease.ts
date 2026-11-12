import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAiopc } from "./aiopc-client";
import { t } from "@/i18n";

export type EnvironmentLeaseHolder = {
  ownerKey: string;
  kind: "automation" | "human";
  sessionId: string | null;
  label: string;
  expiresAt: number;
  waitingForUser: boolean;
};
export type EnvironmentLeaseState = {
  holder: EnvironmentLeaseHolder | null;
  queue: Array<{
    requestId: string;
    kind: string;
    label: string;
    position: number;
  }>;
  bindingRevision: number;
};
type Acquisition = {
  state: "granted" | "queued";
  leaseId?: string;
  requestId?: string;
  position?: number;
  holder: EnvironmentLeaseHolder | null;
  expiresAt?: number;
};
type ManualLease = {
  leaseId: string;
  ownerKey: string;
  bindingRevision: number;
};

/** Watching never holds or renews a lease. Only deliberate take/continue/return actions do. */
export function useEnvironmentLease(
  workspaceRoot: string,
  environmentId: string,
) {
  const { ready, request } = useAiopc(workspaceRoot, environmentId);
  const queryClient = useQueryClient();
  const queryKey = ["aiopc", workspaceRoot, "environment-lease", environmentId];
  const owner = useRef(`viewer:${crypto.randomUUID()}`);
  const [owned, setOwned] = useState<ManualLease | null>(null);
  const [queued, setQueued] = useState<{
    requestId: string;
    position: number;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const [now, setNow] = useState(Date.now());
  const query = useQuery({
    queryKey,
    enabled: ready && Boolean(environmentId),
    queryFn: ({ signal }) =>
      request<EnvironmentLeaseState>("GET", "/api/environment/lease", {
        signal,
      }),
    refetchInterval: 1000,
    retry: false,
  });
  const latest = useRef({
    request,
    owned,
    queued,
    revision: query.data?.bindingRevision,
  });
  latest.current = {
    request,
    owned,
    queued,
    revision: query.data?.bindingRevision,
  };
  const holder = query.data?.holder;
  const controlling = Boolean(
    !query.isError &&
    owned &&
    holder?.ownerKey === owned.ownerKey &&
    query.data?.bindingRevision === owned.bindingRevision &&
    holder.expiresAt > now,
  );
  const remaining =
    controlling && holder
      ? Math.max(0, Math.ceil((holder.expiresAt - now) / 1000))
      : 0;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      const value = latest.current;
      const lease = value.owned;
      const ticket = value.queued;
      if (!lease && !ticket) return;
      void value
        .request("POST", "/api/environment/lease", {
          body: {
            action: lease ? "release" : "cancel",
            manual: true,
            sessionId: owner.current,
            bindingRevision: lease?.bindingRevision ?? value.revision,
            ...(lease
              ? { leaseId: lease.leaseId }
              : { requestId: ticket?.requestId }),
          },
        })
        .catch(() => {});
    },
    [workspaceRoot, environmentId],
  );

  const acquiring = useRef(false);
  const acquire = async (requestId?: string) => {
    const revision = query.data?.bindingRevision;
    if (revision === undefined || acquiring.current) return;
    acquiring.current = true;
    setBusy("acquire");
    setProblem("");
    try {
      await queryClient.cancelQueries({ queryKey });
      const result = await request<Acquisition>(
        "POST",
        "/api/environment/lease",
        {
          body: {
            action: "acquire",
            manual: true,
            sessionId: owner.current,
            label: t("aiopc.lease.you"),
            bindingRevision: revision,
            ...(requestId ? { requestId } : {}),
          },
        },
      );
      if (result.state === "granted" && result.leaseId && result.holder) {
        const lease = {
          leaseId: result.leaseId,
          ownerKey: result.holder.ownerKey,
          bindingRevision: revision,
        };
        latest.current.owned = lease;
        latest.current.queued = null;
        setOwned(lease);
        setQueued(null);
        setNow(Date.now());
        queryClient.setQueryData<EnvironmentLeaseState>(
          queryKey,
          (current) => ({
            holder: result.holder,
            queue: current?.queue ?? [],
            bindingRevision: revision,
          }),
        );
      } else if (result.state === "queued" && result.requestId) {
        const ticket = {
          requestId: result.requestId,
          position: result.position ?? 1,
        };
        latest.current.queued = ticket;
        setQueued(ticket);
      } else throw new Error(t("aiopc.lease.unavailable"));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      acquiring.current = false;
      setBusy("");
    }
  };
  useEffect(() => {
    if (
      owned &&
      query.data &&
      (query.data.bindingRevision !== owned.bindingRevision ||
        holder?.ownerKey !== owned.ownerKey ||
        holder.expiresAt <= now)
    )
      setOwned(null);
  }, [owned, query.data, holder, now]);
  const acquireRef = useRef(acquire);
  acquireRef.current = acquire;
  useEffect(() => {
    if (!queued) return;
    const timer = setInterval(() => {
      void acquireRef.current(queued.requestId);
    }, 2000);
    return () => clearInterval(timer);
  }, [queued?.requestId]);
  const update = async (action: "heartbeat" | "release" | "cancel") => {
    const lease = owned;
    const ticket = queued;
    if (action === "cancel" ? !ticket : !lease) return;
    setBusy(action);
    setProblem("");
    // Revoke browser input immediately, even while an offline server is being retried.
    if (action === "release") setOwned(null);
    if (action === "cancel") setQueued(null);
    try {
      await request("POST", "/api/environment/lease", {
        body: {
          action,
          manual: true,
          sessionId: owner.current,
          bindingRevision:
            lease?.bindingRevision ?? query.data?.bindingRevision,
          ...(lease
            ? { leaseId: lease.leaseId }
            : { requestId: ticket?.requestId }),
          ...(action === "heartbeat" ? { activity: true } : {}),
        },
      });
      if (action === "release") latest.current.owned = null;
      if (action === "cancel") latest.current.queued = null;
      await query.refetch();
      setNow(Date.now());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };
  return {
    query,
    controlling,
    remaining,
    holder,
    queued,
    busy,
    problem: problem || (query.isError ? query.error.message : ""),
    take: () => acquire(),
    renew: () => update("heartbeat"),
    release: () => update("release"),
    cancel: () => update("cancel"),
  };
}
