import { adminRoute } from "@/modules/admin";
import { goldenRender } from "@/modules/labels/golden";

export const dynamic = "force-dynamic";

export const GET = adminRoute(async () => ({
  ...(await goldenRender()),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
}));
