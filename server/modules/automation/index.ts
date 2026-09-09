export {
  default as automationRoutes,
  createAutomationRouter,
  createBrowserAutomationRouter,
} from './automation.routes.js';
export {
  automationService, AutomationService, configureDesktopRestartAdmission,
  createAutomationDesktopRestartReader, createBrowserDesktopRestartReader, createComputerDesktopRestartReader,
} from './automation.service.js';
export { handleBrowserConnection } from './browser-websocket.js';
export { CUA_SAFE_TOOLS, type CuaSafeTool } from './cua-client.js';
export type { BrowserCommand, BrowserInput, BrowserSessionState } from './browser-protocol.js';
