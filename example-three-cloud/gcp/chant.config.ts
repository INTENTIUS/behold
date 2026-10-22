// The project every gcp resource builds, applies and is read in.
export default { lexicons: ["gcp"], sourceDir: "src", environments: [{ name: "local", endpoint: "http://localhost:4588" }], gcp: { project: "three-cloud" } };
