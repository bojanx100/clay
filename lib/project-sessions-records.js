var attachProjectSessionsRecordsHandlers = require("./project-sessions-records-handlers").attachProjectSessionsRecordsHandlers;

function attachProjectSessionsRecords(ctx) {
  var handlers = attachProjectSessionsRecordsHandlers(ctx);

  function handleRecordsMessage(ws, msg) {
    var type = msg && msg.type;
    if (!Object.prototype.hasOwnProperty.call(handlers, type)) return false;
    handlers[type](ws, msg);
    return true;
  }

  return {
    handleRecordsMessage: handleRecordsMessage,
  };
}

module.exports = { attachProjectSessionsRecords: attachProjectSessionsRecords };
