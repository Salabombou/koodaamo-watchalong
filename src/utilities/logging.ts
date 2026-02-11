import winston from "winston";
import isDev from "electron-is-dev";
import os from "os";

let logFilePath: string;
switch (os.platform()) {
  case "win32":
    logFilePath = `${os.homedir()}\\AppData\\Roaming\\koodaamo-watchalong\\logs\\app.log`;
    break;
  case "darwin":
    logFilePath = `${os.homedir()}/Library/Logs/koodaamo-watchalong/app.log`;
    break;
  case "linux":
    logFilePath = `${os.homedir()}/.koodaamo-watchalong/logs/app.log`;
    break;
  default:
    throw new Error(`Unsupported platform: ${os.platform()}`);
}

const logger = winston.createLogger({
  level: isDev ? "debug" : "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    }),
    isDev
      ? winston.format.colorize({ all: true })
      : winston.format.uncolorize(),
  ),
});

if (isDev) logger.add(new winston.transports.Console());
else logger.add(new winston.transports.File({ filename: logFilePath }));

export default logger;
