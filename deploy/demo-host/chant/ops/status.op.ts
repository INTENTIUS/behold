import { Op, phase, shell } from "@intentius/chant/op";
import { demoHost } from "./remote";

/** Read only: the containers, demo.json and the last stalls, over ssh. */
export default Op({
  name: "demo-host-status",
  overview: "Show the demo host's containers, demo.json and last stalls (demo-host.sh status). Changes nothing.",
  labels: { Host: "demo-host" },
  phases: [phase("Status", [shell(demoHost("status"))])],
});
