/**
 * Host half of the task-completion alert bundle.
 *
 * Detection, sound, and the notice surface all live in the browser half
 * (`./client.js`), which the module system loads through this package's
 * `dsh.client` declaration. This host half exists so the plugin appears as an
 * ordinary Loader entry in the profile tree; it registers no host service, no
 * tool, and no session event, so it is inert on the Host.
 */
export function apply() {}
