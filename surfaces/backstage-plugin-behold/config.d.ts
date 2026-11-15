export interface Config {
  /** Settings for the behold Infrastructure tab. */
  behold?: {
    /**
     * Where the published export is: the site that holds `graph.json` (and
     * `behold.html`, the single-file viewer, when there is one). An entity's
     * `behold.intentius.io/export-url` annotation overrides it. A URL that
     * ends in `.json` is taken as the document itself.
     * @visibility frontend
     */
    exportUrl?: string;
    /**
     * A `proxy.endpoints` path (for example `/behold`) that fronts the export,
     * for a bucket the browser cannot read. When set, `graph.json` is fetched
     * from `<backend>/api/proxy<proxyPath>/graph.json` with the user's
     * Backstage token, and `exportUrl` is only the address the tab links to.
     * @visibility frontend
     */
    proxyPath?: string;
    /**
     * The single-file viewer to draw the cut in, as an iframe. When unset, the
     * tab uses `behold.html` beside `exportUrl` if it is there, and its own
     * drawing if it is not.
     * @visibility frontend
     */
    viewerUrl?: string;
  };
}
