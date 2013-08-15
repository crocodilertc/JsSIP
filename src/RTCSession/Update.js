/**
 * @fileoverview Update
 */

/**
 * @param {JsSIP} JsSIP - The JsSIP namespace
 * @returns {function} The Update constructor
 */
(function(JsSIP) {
  
  var Update;
  
  /**
   * @class Update
   * @param {JsSIP.RTCSession} session
   */
  Update = function(session) {
    var events = [
    'succeeded',
    'failed'
    ];
  
    this.session = session;
    this.direction = null;
    this.accepted = null;
  
    this.initEvents(events);
  };
  Update.prototype = new JsSIP.EventEmitter();
  
  
  Update.prototype.send = function(options) {
    var request_sender, event, eventHandlers, extraHeaders, sdp;
  
    this.direction = 'outgoing';
  
    // Check RTCSession Status
    if (this.session.status !== JsSIP.RTCSession.C.STATUS_CONFIRMED &&
        this.session.status !== JsSIP.RTCSession.C.STATUS_WAITING_FOR_ACK) {
      throw new JsSIP.Exceptions.InvalidStateError(this.session.status);
    }
  
    // Get Update options
    options = options || {};
    extraHeaders = options.extraHeaders ? options.extraHeaders.slice() : [];
    eventHandlers = options.eventHandlers || {};
    sdp = options.sdp;
  
    // Set event handlers
    for (event in eventHandlers) {
      this.on(event, eventHandlers[event]);
    }
  
    extraHeaders.push('Contact: '+ this.session.contact);
    if (sdp) {
      extraHeaders.push('Content-Type: application/sdp');
    }
  
    this.request = this.session.dialog.createRequest(JsSIP.C.UPDATE, extraHeaders);
  
    this.request.body = sdp;
  
    request_sender = new RequestSender(this);
  
    this.session.emit('update', this.session, {
      originator: 'local',
      update: this,
      request: this.request
    });
  
    request_sender.send();
  };
  
  /**
   * @private
   */
  Update.prototype.receiveResponse = function(response) {
    var cause;
  
    // Double-check that the session has not been terminated
    if (this.session.status !== JsSIP.RTCSession.C.STATUS_CONFIRMED) {
      return;
    }

    switch(true) {
      case /^1[0-9]{2}$/.test(response.status_code):
        // Ignore provisional responses.
        break;
  
      case /^2[0-9]{2}$/.test(response.status_code):
        this.session.dialog.processSessionTimerHeaders(response);
        this.emit('succeeded', this, {
          originator: 'remote',
          response: response
        });
        break;
  
      default:
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
  Update.prototype.onRequestTimeout = function() {
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.REQUEST_TIMEOUT
    });
  };
  
  /**
   * @private
   */
  Update.prototype.onTransportError = function() {
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.CONNECTION_ERROR
    });
  };
  
  /**
   * @private
   * @returns {Boolean} true if a 2xx response was sent, false otherwise
   */
  Update.prototype.init_incoming = function(request) {
    this.direction = 'incoming';
    this.request = request;
  
    this.session.emit('update', this.session, {
      originator: 'remote',
      update: this,
      request: request
    });

    if (this.accepted === null) {
      // No response sent yet
      // Just accept empty UPDATEs (for session timer refreshes)
      var contentType = request.getHeader('content-type');
      if(contentType || request.body) {
        this.reject({status_code: 488});
      } else {
        this.accept();
      }
    }

    return this.accepted;
  };
  
  /**
   * Accept the incoming Update
   * Only valid for incoming Updates
   */
  Update.prototype.accept = function(options) {
    options = options || {};

    var
      extraHeaders = options.extraHeaders || [],
      body = options.body;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "accept" for an outgoing update');
    }

    this.session.dialog.processSessionTimerHeaders(this.request);
    this.session.dialog.addSessionTimerResponseHeaders(extraHeaders);

    extraHeaders.push('Contact: ' + this.session.contact);

    this.request.reply(200, null, extraHeaders, body);
    this.accepted = true;
  };

  /**
   * Reject the incoming Update
   * Only valid for incoming Updates
   *
   * @param {Number} status_code
   * @param {String} [reason_phrase]
   */
  Update.prototype.reject = function(options) {
    options = options || {};

    var
      status_code = options.status_code || 480,
      reason_phrase = options.reason_phrase,
      extraHeaders = options.extraHeaders || [],
      body = options.body;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "reject" for an outgoing update');
    }

    if (status_code < 300 || status_code >= 700) {
      throw new TypeError('Invalid status_code: '+ status_code);
    }

    this.request.reply(status_code, reason_phrase, extraHeaders, body);
    this.accepted = false;
  };

  return Update;
}(JsSIP));

