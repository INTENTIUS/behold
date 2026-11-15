// behold#725: the shared beat paused in a hidden tab, and the shared tooltip for the graph's badges.
// A file rather than an inline module (behold#1068): a webview's content security policy blocks inline scripts.
import { installMotion } from "./motion.js";
import { installTooltips } from "./tooltip.js";
installMotion();
installTooltips(document);
