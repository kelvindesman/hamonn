// Smoke: run the isomorphic-git landing wire *inside workerd* against a git smart-HTTP server.
import { IsomorphicWire } from "@hamonn/gitwire-isomorphic";
import http from "isomorphic-git/http/web";

export default {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const base = u.searchParams.get("base");
    if (!base) return new Response("need ?base=", { status: 400 });
    const wire = new IsomorphicWire({ http });
    const input = {
      integrationRemote: `${base}/main.git`,
      laneRemote: `${base}/lane.git`,
      integrationBranch: "main",
      laneBranch: "main",
      message: "Land lane #1 (workerd smoke)",
      author: { name: "hamonn", email: "hamonn@users.noreply.local" },
    };
    const result = await wire.land(input);
    const proof =
      result.kind === "clean"
        ? await wire.isAncestor({
            remote: input.integrationRemote,
            branch: "main",
            ancestor: u.searchParams.get("laneHead") ?? "",
            descendant: result.sha,
          })
        : null;
    return Response.json({ result, proof });
  },
};
