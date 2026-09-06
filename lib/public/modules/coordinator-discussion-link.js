import { sessionRefUrlSuffix } from "./session-tab-state.js";

export function appendCoordinatorDiscussionLink(container, ref) {
  if (!ref || ref.projectId !== "system-lead" ||
      typeof ref.sessionStorageId !== "string" || !ref.sessionStorageId) return;
  var link = document.createElement("a");
  link.href = "/p/lead/" + sessionRefUrlSuffix(ref);
  link.textContent = " Open coordinator conversation";
  container.appendChild(link);
}
