import { describe, expect, it } from "bun:test";

export type AdapterContractProbes = {
  pagination(): Promise<number>;
  staleHeadWrites(): Promise<number>;
  partialRetry(): Promise<{ inlineWrites: number; mainWrites: number }>;
  markerOwnership(): Promise<{ foreignWrites: number; ownedWritesAfterRerun: number }>;
  statusIdempotency(): Promise<{
    firstId: string;
    secondId: string;
    nativeRecords: number;
    statusWrites: number;
  }>;
  threadActions(): Promise<{ replies: number; resolutions: number }>;
};

export function runCodeHostAdapterContract(provider: string, probes: AdapterContractProbes): void {
  describe(`${provider} shared adapter contract`, () => {
    it("consumes every page of provider comments", async () => {
      expect(await probes.pagination()).toBe(2);
    });

    it("performs zero writes when the reviewed head is stale", async () => {
      expect(await probes.staleHeadWrites()).toBe(0);
    });

    it("reconciles an accepted partial write before retrying publication", async () => {
      expect(await probes.partialRetry()).toEqual({ inlineWrites: 1, mainWrites: 1 });
    });

    it("does not claim foreign markers or duplicate its own marker", async () => {
      expect(await probes.markerOwnership()).toEqual({
        foreignWrites: 1,
        ownedWritesAfterRerun: 1,
      });
    });

    it("upserts one native status for repeated status calls", async () => {
      const status = await probes.statusIdempotency();
      expect(status.secondId).toBe(status.firstId);
      expect(status.nativeRecords).toBe(1);
      expect(status.statusWrites).toBe(2);
    });

    it("publishes one idempotent thread reply", async () => {
      expect((await probes.threadActions()).replies).toBe(1);
    });

    it("resolves a thread once", async () => {
      expect((await probes.threadActions()).resolutions).toBe(1);
    });
  });
}
