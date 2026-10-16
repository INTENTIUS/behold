// behold#571: the event-help ("Tips") switch, shared by the kiosk and the full
// app: on unless a viewer turned it off, kept in their own browser.

/** Where a viewer's Tips switch is kept. */
export const EH_STORE = "behold.eventHelp";

/** Tips, on unless the viewer turned them off; on when storage refuses. */
export function ehStored(store) {
  try {
    return !(store && store.getItem(EH_STORE) === "off");
  } catch {
    return true;
  }
}

/** Keep the viewer's Tips switch; quiet where storage refuses (a private window). */
export function ehStore(store, on) {
  try {
    if (store) store.setItem(EH_STORE, on ? "on" : "off");
  } catch {
    /* the switch lasts this visit */
  }
}
