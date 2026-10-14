/**
 * src/utils/fileManager.js
 * Alias and re-export for backward compatibility with src/storage/fileManager
 */
const storageFileManager = require('../storage/fileManager');

module.exports = {
  ...storageFileManager,
  FileManager: storageFileManager.FileManager,
  defaultFileManager: storageFileManager.defaultFileManager
};
