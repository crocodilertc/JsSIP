/**
 * @fileoverview Reinvite
 */

/**
 * @param {JsSIP} JsSIP - The JsSIP namespace
 * @returns {function} The Reinvite constructor
 */
(function(JsSIP) {
  
  var Reinvite,
    LOG_PREFIX = JsSIP.name +' | '+ 'REINVITE' +' | ';
  
  /**
   * @class Reinvite
   * @param {JsSIP.RTCSession} session
   */
  Reinvite = function(session) {
    var events = [
    'succeeded',
    'failed',
    'completed'
    ];
  
    this.session = session;
    this.direction = null;
    this.status = JsSIP.RTCSession.C.STATUS_NULL;
    this.timers = {};
  
    this.initEvents(events);
  };
  Reinvite.prototype = new JsSIP.EventEmitter();
  
  
  Reinvite.prototype.send = function(sdp, options) {
    var request_sender, event, eventHandlers, extraHeaders;
  
    if (sdp === undefined) {
      throw new TypeError('Not enough arguments');
    }
  
    this.direction = 'outgoing';
  
    // Check RTCSession Status
    if (this.session.status !== JsSIP.RTCSession.C.STATUS_CONFIRMED) {
      throw new JsSIP.Exceptions.InvalidStateError(this.session.status);
    }
  
    // Get options
    options = options || {};
    extraHeaders = options.extraHeaders ? options.extraHeaders.slice() : [];
    eventHandlers = options.eventHandlers || {};
  
    // Set event handlers
    for (event in eventHandlers) {
      this.on(event, eventHandlers[event]);
    }
  
    extraHeaders.push('Contact: '+ this.session.contact);
    extraHeaders.push('Allow: '+ JsSIP.Utils.getAllowedMethods(this.session.ua, true));
    if (sdp) {
      extraHeaders.push('Content-Type: application/sdp');
    }
  
    this.request = this.session.dialog.createRequest(JsSIP.C.INVITE, extraHeaders);
  
    this.request.body = sdp;
  
    request_sender = new RequestSender(this);
  
    this.session.emit('reinvite', this.session, {
      originator: 'local',
      reinvite: this,
      request: this.request
    });
  
    request_sender.send();
    this.status = JsSIP.RTCSession.C.STATUS_INVITE_SENT;
  };
  
  /**
   * @private
   */
  Reinvite.prototype.receiveResponse = function(response) {
    var code = response.status_code;
    var cause;

    switch (this.status) {
    case JsSIP.RTCSession.C.STATUS_CONFIRMED:
    case JsSIP.RTCSession.C.STATUS_CANCELED:
      // Looks like a retransmission
      // Double-check that the session has not been terminated
      if (this.session.status === JsSIP.RTCSession.C.STATUS_CONFIRMED) {
        console.info(LOG_PREFIX +'Retransmitting ACK');
        this.session.sendACK();
      }
      return;
    }

    if (code >= 100 && code < 200) {
      // Ignore provisional responses.
      this.status = JsSIP.RTCSession.C.STATUS_1XX_RECEIVED;
      return;
    }

    if (code >= 200 && code < 300) {
      this.status = JsSIP.RTCSession.C.STATUS_CONFIRMED;
      // Double-check that the session has not been terminated
      if (this.session.status === JsSIP.RTCSession.C.STATUS_CONFIRMED) {
        this.session.sendACK();
        console.log(LOG_PREFIX +'re-INVITE ACK sent', Date.now());
        this.emit('succeeded', this, {
          originator: 'remote',
          response: response,
          sdp: response.body
        });
      }
    } else {
      // Rejecting a reinvite only rejects the change to the session.
      // The session itself is still valid.
      this.status = JsSIP.RTCSession.C.STATUS_CANCELED;
      // Ack sent by transaction layer 
      cause = JsSIP.Utils.sipErrorCause(response.status_code);
      this.emit('failed', this, {
        originator: 'remote',
        response: response,
        cause: cause
      });
    }

    this.emit('completed', this, {
      originator: 'local'
    });
  };
  
  /**
   * @private
   */
  Reinvite.prototype.receiveAck = function() {
    this.status = JsSIP.RTCSession.C.STATUS_CONFIRMED;
    console.log(LOG_PREFIX +'re-INVITE ACK received', Date.now());
    if (this.timers.invite2xxTimer) {
      window.clearTimeout(this.timers.invite2xxTimer);
      delete this.timers.invite2xxTimer;
    }
    if (this.timers.ackTimer) {
      window.clearTimeout(this.timers.ackTimer);
      delete this.timers.ackTimer;
    }
    this.emit('completed', this, {
      originator: 'remote'
    });
  };
  
  /**
   * @private
   */
  Reinvite.prototype.onRequestTimeout = function() {
    this.status = JsSIP.RTCSession.C.STATUS_TERMINATED;
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.REQUEST_TIMEOUT
    });
  };
  
  /**
   * @private
   */
  Reinvite.prototype.onTransportError = function() {
    switch (this.status) {
    case JsSIP.RTCSession.C.STATUS_CONFIRMED:
    case JsSIP.RTCSession.C.STATUS_CANCELED:
    case JsSIP.RTCSession.C.STATUS_TERMINATED:
      // Transport closed before the transaction terminated, but we were done anyway
      return;
    }

    this.status = JsSIP.RTCSession.C.STATUS_TERMINATED;
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.CONNECTION_ERROR
    });
  };
  
  /**
   * @private
   */
  Reinvite.prototype.init_incoming = function(request) {
    var sdp = null,
      contentType = request.getHeader('Content-Type');
  
    this.direction = 'incoming';
    this.request = request;
    this.status = JsSIP.RTCSession.C.STATUS_INVITE_RECEIVED;
  
    if (request.body && contentType === 'application/sdp') {
      sdp = request.body;
    }
  
    this.session.emit('reinvite', this.session, {
      originator: 'remote',
      reinvite: this,
      request: request,
      sdp: sdp
    });
  };
  
  /**
   * @private
   */
  Reinvite.prototype.successResponseSent = function(request, extraHeaders, body) {
    var self = this.session,
      retransmissions = 1,
      timeout = JsSIP.Timers.T1;

    /**
     * RFC3261 13.3.1.4
     * Response retransmissions cannot be accomplished by transaction layer
     *  since it is destroyed when receiving the first 2xx answer
     */
    this.timers.invite2xxTimer = window.setTimeout(function invite2xxRetransmission() {
        if (self.status !== JsSIP.RTCSession.C.STATUS_WAITING_FOR_ACK) {
          return;
        }

        console.log(LOG_PREFIX +'Retransmitting 2xx:', retransmissions++);
        request.reply(200, null, extraHeaders, body);

        if (timeout < JsSIP.Timers.T2) {
          timeout = timeout * 2;
          if (timeout > JsSIP.Timers.T2) {
            timeout = JsSIP.Timers.T2;
          }
        }
        self.timers.invite2xxTimer = window.setTimeout(invite2xxRetransmission,
          timeout
        );
      },
      timeout
    );
    console.log(LOG_PREFIX +'re-INVITE response sent', Date.now());

    /**
     * RFC3261 14.2
     * If a UAS generates a 2xx response and never receives an ACK,
     *  it SHOULD generate a BYE to terminate the dialog.
     */
    this.timers.ackTimer = window.setTimeout(function() {
        if(self.status === JsSIP.RTCSession.C.STATUS_WAITING_FOR_ACK) {
          console.log(LOG_PREFIX + 'no ACK received, terminating the call');
          if (self.timers.invite2xxTimer) {
            window.clearTimeout(self.timers.invite2xxTimer);
            delete self.timers.invite2xxTimer;
          }
          self.session.sendBye();
          self.session.ended('remote', null, JsSIP.C.causes.NO_ACK);
        }
      },
      JsSIP.Timers.TIMER_H
    );
  };

  /**
   * Indicates that the incoming SDP is valid
   * Only valid for incoming reINVITEs
   */
  Reinvite.prototype.sdpValid = function() {
    var self = this,
      request = this.request,
      expires = null,
      no_answer_timeout = self.session.ua.configuration.no_answer_timeout;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "sdpValid" for an outgoing reINVITE');
    }

    this.status = JsSIP.RTCSession.C.STATUS_WAITING_FOR_ANSWER;

    //Get the Expires header value if exists
    if(request.hasHeader('expires')) {
      expires = request.getHeader('expires') * 1000;
    }

    // Schedule a provisional response for 1 second's time - this will be
    // cancelled if the application calls the accept() or reject() method first.
    this.timers.provisionalResponse = window.setTimeout(function () {
      // Start sending provisional responses while we await a final answer
      request.reply(180, null, ['Contact: ' + self.session.contact]);
      delete self.timers.provisionalResponse;
    }, 1000);

    if (expires && expires < no_answer_timeout) {
      // Set expiresTimer (see RFC3261 13.3.1)
      this.timers.answer = window.setTimeout(function() {
          request.reply(487);
          self.emit('failed', self, {
            originator: 'system',
            cause: JsSIP.C.causes.EXPIRES
          });
        }, expires
      );
    } else {
      // Set userNoAnswerTimer
      this.timers.answer = window.setTimeout(function() {
          request.reply(480);
          self.emit('failed', self, {
            originator: 'local',
            cause: JsSIP.C.causes.NO_ANSWER
          });
        }, no_answer_timeout
      );
    }
  };

  /**
   * Indicates that the incoming SDP is invalid
   * Only valid for incoming reINVITEs
   */
  Reinvite.prototype.sdpInvalid = function() {
    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "sdpInvalid" for an outgoing reINVITE');
    }
  
    this.request.reply(488);
    this.status = JsSIP.RTCSession.C.STATUS_WAITING_FOR_ACK;
    this.emit('failed', this, {
      originator: 'remote',
      cause: JsSIP.C.causes.BAD_MEDIA_DESCRIPTION
    });
  };

  /**
   * Accept the incoming reINVITE
   * Only valid for incoming reINVITEs
   */
  Reinvite.prototype.accept = function(options) {
    options = options || {};
  
    var self = this,
      extraHeaders = options.extraHeaders || [],
      sdp = options.sdp;
  
    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "accept" for an outgoing reINVITE');
    }
  
    if (this.timers.provisionalResponse) {
      window.clearTimeout(this.timers.provisionalResponse);
      delete this.timers.provisionalResponse;
    }
    if (this.timers.answer) {
      window.clearTimeout(this.timers.answer);
      delete this.timers.answer;
    }
  
    extraHeaders.push('Contact: ' + self.session.contact);
    extraHeaders.push('Allow: '+ JsSIP.Utils.getAllowedMethods(self.session.ua, true));
    extraHeaders.push('Content-Type: application/sdp');

    var replyFailed = function () {
      self.session.onTransportError();
      self.onTransportError();
    };

    this.request.reply(200, null, extraHeaders,
      sdp,
      this.successResponseSent.bind(this, this.request, extraHeaders, sdp),
      replyFailed
    );
    this.status = JsSIP.RTCSession.C.STATUS_WAITING_FOR_ACK;
  };
  
  /**
   * Reject the incoming reINVITE
   * Only valid for incoming reINVITEs
   *
   * @param {Number} status_code
   * @param {String} [reason_phrase]
   */
  Reinvite.prototype.reject = function(options) {
    options = options || {};
  
    var
      status_code = options.status_code || 480,
      reason_phrase = options.reason_phrase,
      extraHeaders = options.extraHeaders || [];
  
    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "reject" for an outgoing reINVITE');
    }
  
    if (status_code < 300 || status_code >= 700) {
      throw new TypeError('Invalid status_code: '+ status_code);
    }

    if (this.timers.provisionalResponse) {
      window.clearTimeout(this.timers.provisionalResponse);
      delete this.timers.provisionalResponse;
    }
    if (this.timers.answer) {
      window.clearTimeout(this.timers.answer);
      delete this.timers.answer;
    }
  
    this.request.reply(status_code, reason_phrase, extraHeaders);
    this.status = JsSIP.RTCSession.C.STATUS_WAITING_FOR_ACK;
  };
  
  Reinvite.C = C;
  return Reinvite;
}(JsSIP));
