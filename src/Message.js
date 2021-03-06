/**
 * @fileoverview Message
 */

/**
 * @augments JsSIP
 * @class Class creating SIP MESSAGE request.
 * @param {JsSIP.UA} ua
 */
(function(JsSIP) {
var Message;

Message = function(ua) {
  this.ua = ua;
  this.direction = null;
  this.local_identity = null;
  this.remote_identity = null;

  // Custom message empty object for high level use
  this.data = {};
};
Message.prototype = new JsSIP.EventEmitter();


Message.prototype.send = function(target, body, options) {
  var request_sender, event, contentType, eventHandlers, extraHeaders,
    events = [
      'succeeded',
      'failed'
    ],
    invalidTarget = false;

  if (target === undefined || body === undefined) {
    throw new TypeError('Not enough arguments');
  }

  this.initEvents(events);

  // Get call options
  options = options || {};
  extraHeaders = options.extraHeaders || [];
  eventHandlers = options.eventHandlers || {};
  contentType = options.contentType || 'text/plain';

  // Set event handlers
  for (event in eventHandlers) {
    this.on(event, eventHandlers[event]);
  }

  // Check target validity
  try {
    target = JsSIP.Utils.normalizeURI(target, this.ua.configuration.hostport_params);
  } catch(e) {
    target = JsSIP.URI.parse(JsSIP.C.INVALID_TARGET_URI);
    invalidTarget = true;
  }

  // Message parameter initialization
  this.direction = 'outgoing';
  this.local_identity = this.ua.configuration.uri;
  this.remote_identity = target;

  this.closed = false;
  this.ua.applicants[this] = this;

  extraHeaders.push('Content-Type: '+ contentType);

  this.request = new JsSIP.OutgoingRequest(JsSIP.C.MESSAGE, target, this.ua, null, extraHeaders);

  if(body) {
    this.request.body = body;
  }

  request_sender = new JsSIP.RequestSender(this, this.ua);

  this.ua.emit('newMessage', this.ua, {
    originator: 'local',
    message: this,
    request: this.request
  });

  if (invalidTarget) {
    this.emit('failed', this, {
      originator: 'local',
      cause: JsSIP.C.causes.INVALID_TARGET
    });
  } else {
    request_sender.send();
  }
};

/**
* @private
*/
Message.prototype.receiveResponse = function(response) {
  var cause;

  if(this.closed) {
    return;
  }
  switch(true) {
    case /^1[0-9]{2}$/.test(response.status_code):
      // Ignore provisional responses.
      break;

    case /^2[0-9]{2}$/.test(response.status_code):
      delete this.ua.applicants[this];
      this.emit('succeeded', this, {
        originator: 'remote',
        response: response
      });
      break;

    default:
      delete this.ua.applicants[this];
      cause = JsSIP.Utils.sipErrorCause(response.status_code);
      this.emit('failed', this, {
        originator: 'remote',
        response: response,
        cause: cause
      });
      break;
  }
};


/**
* @private
*/
Message.prototype.onRequestTimeout = function() {
  if(this.closed) {
    return;
  }
  this.emit('failed', this, {
    originator: 'system',
    cause: JsSIP.C.causes.REQUEST_TIMEOUT
  });
};

/**
* @private
*/
Message.prototype.onTransportError = function() {
  if(this.closed) {
    return;
  }
  this.emit('failed', this, {
    originator: 'system',
    cause: JsSIP.C.causes.CONNECTION_ERROR
  });
};

/**
* @private
*/
Message.prototype.close = function() {
  this.closed = true;
  delete this.ua.applicants[this];
};

/**
 * @private
 */
Message.prototype.init_incoming = function(request) {
  var transaction;

  this.direction = 'incoming';
  this.request = request;
  this.local_identity = request.to.uri;
  this.remote_identity = request.from.uri;

  this.ua.emit('newMessage', this.ua, {
    originator: 'remote',
    message: this,
    request: request
  });

  transaction = this.ua.transactions.nist[request.via_branch];

  if (transaction && (transaction.state === JsSIP.Transactions.C.STATUS_TRYING || transaction.state === JsSIP.Transactions.C.STATUS_PROCEEDING)) {
    request.reply(200);
  }
};

/**
 * Accept the incoming Message
 * Only valid for incoming Messages
 */
Message.prototype.accept = function(options) {
  options = options || {};

  var
    extraHeaders = options.extraHeaders || [],
    body = options.body;

  if (this.direction !== 'incoming') {
    throw new TypeError('Invalid method "accept" for an outgoing message');
  }

  this.request.reply(200, null, extraHeaders, body);
};

/**
 * Reject the incoming Message
 * Only valid for incoming Messages
 *
 * @param {Number} status_code
 * @param {String} [reason_phrase]
 */
Message.prototype.reject = function(options) {
  options = options || {};

  var
    status_code = options.status_code || 480,
    reason_phrase = options.reason_phrase,
    extraHeaders = options.extraHeaders || [],
    body = options.body;

  if (this.direction !== 'incoming') {
    throw new TypeError('Invalid method "reject" for an outgoing message');
  }

  if (status_code < 300 || status_code >= 700) {
    throw new TypeError('Invalid status_code: '+ status_code);
  }

  this.request.reply(status_code, reason_phrase, extraHeaders, body);
};

JsSIP.Message = Message;
}(JsSIP));
