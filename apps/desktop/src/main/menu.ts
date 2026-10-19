/** Native application menu. Commands are forwarded to the renderer. */
import { Menu, app, shell, type MenuItemConstructorOptions } from "electron";

import type { DesktopMenuCommand, RecentWorldFile } from "../../shared/ipc";

interface MenuDeps {
  isDev: boolean;
  recentFiles: RecentWorldFile[];
  onCommand: (command: DesktopMenuCommand) => void;
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
}

export function buildMenu(deps: MenuDeps): Menu {
  const isMac = process.platform === "darwin";
  const recentItems: MenuItemConstructorOptions[] = deps.recentFiles.length
    ? [
        ...deps.recentFiles.map<MenuItemConstructorOptions>((file) => ({
          label: `${file.name} — ${file.path}`,
          click: () => deps.onOpenRecent(file.path),
        })),
        { type: "separator" },
        { label: "清除最近文件", click: deps.onClearRecent },
      ]
    : [{ label: "（暂无最近文件）", enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: "Atlas Forge",
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新建世界", accelerator: "CmdOrCtrl+N", click: () => deps.onCommand("new-world") },
        { label: "打开世界…", accelerator: "CmdOrCtrl+O", click: () => deps.onCommand("open-world") },
        { label: "打开最近", submenu: recentItems },
        { type: "separator" },
        { label: "保存", accelerator: "CmdOrCtrl+S", click: () => deps.onCommand("save-world") },
        { label: "另存为…", accelerator: "CmdOrCtrl+Shift+S", click: () => deps.onCommand("save-world-as") },
        { type: "separator" },
        { label: "导出 PNG（本地原图）…", accelerator: "CmdOrCtrl+E", click: () => deps.onCommand("export-png") },
        { label: "导出 SVG（矢量）…", accelerator: "CmdOrCtrl+Shift+E", click: () => deps.onCommand("export-svg") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "地图装饰…", accelerator: "CmdOrCtrl+D", click: () => deps.onCommand("open-decorations") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools", visible: deps.isDev },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "使用说明", click: () => deps.onCommand("help") },
        { label: "Atlas Forge 项目主页", click: () => void shell.openExternal("https://github.com/Umamed26/atlas-forge") },
        { type: "separator" },
        { label: `版本 ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
