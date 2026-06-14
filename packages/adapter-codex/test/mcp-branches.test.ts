import { describe, expect, it } from "vitest";
import { mcpRunConfig, mcpServerName } from "../src/mcp";

describe("codex mcpRunConfig branches", () => {
  it("pypi -> uvx", () => {
    expect(mcpRunConfig({ packages: [{ registryType: "pypi", identifier: "p" }] })).toEqual({
      command: "uvx",
      args: ["p"],
    });
  });
  it("oci -> docker", () => {
    expect(mcpRunConfig({ packages: [{ registryType: "oci", identifier: "img" }] })).toEqual({
      command: "docker",
      args: ["run", "-i", "--rm", "img"],
    });
  });
  it("remote -> url only (no transport key)", () => {
    expect(mcpRunConfig({ remotes: [{ url: "https://x" }] })).toEqual({ url: "https://x" });
  });
  it("bare command passthrough", () => {
    expect(mcpRunConfig({ command: "node", args: ["s"], env: { X: "1" } })).toEqual({
      command: "node",
      args: ["s"],
      env: { X: "1" },
    });
  });
  it("fallback when no runnable transport", () => {
    expect(mcpRunConfig({})).toEqual({
      command: "echo",
      args: ["server.json declares no runnable transport"],
    });
  });
  it("server name fallback", () => {
    expect(mcpServerName({})).toBe("server");
  });
});
