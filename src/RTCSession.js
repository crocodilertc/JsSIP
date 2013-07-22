/**
 * @fileoverview Session
 */

/**
 * @augments JsSIP
 * @class Invite Session
 */
(function(JsSIP) {

// Load dependencies
var RequestSender   = @@include('../src/RTCSession/RequestSender.js')
var RTCMediaHandler = @@include('../src/RTCSession/RTCMediaHandler.js')
var DTMF            = @@include('../src/RTCSession/DTMF.js')
var Reinvite        = @@include('../src/RTCSession/Reinvite.js')
var Update          = @@include('../src/RTCSession/Update.js')

var RTCSession,
  LOG_PREFIX = JsSIP.name +' | '+ 'RTC SESSION' +' | ',
  C = {
    // RTCSession states
    STATUS_NULL:               0,
    STATUS_INVITE_SENT:        1,
    STATUS_1XX_RECEIVED:       2,
    STATUS_INVITE_RECEIVED:    3,
    STATUS_WAITING_FOR_ANSWER: 4,
    STATUS_WAITING_FOR_ACK:    5,
    STATUS_CANCELED:           6,
    STATUS_TERMINATED:         7,
    STATUS_CONFIRMED:          8
  };


RTCSession = function(ua) {
  var events = [
  'progress',
  'failed',
  'started',
  'ended',
  'newDTMF',
  'reinvite',
  'refresh',
  'update'
  ];

  this.ua = ua;
  this.status = C.STATUS_NULL;
  this.lastReinvite = null;
  this.dialog = null;
  this.earlyDialogs = {};
  this.rtcMediaHandler = null;

  // Session Timers
  this.timers = {
    ackTimer: null,
    expiresTimer: null,
    invite2xxTimer: null,
    userNoAnswerTimer: null
  };

  // Session info
  this.direction = null;
  this.local_identity = null;
  this.remote_identity = null;
  this.start_time = null;
  this.end_time = null;
  this.tones = null;
  this.allowed = null;

  // Custom session empty object for high level use
  this.data = {};

  this.initEvents(events);
};
RTCSession.prototype = new JsSIP.EventEmitter();


/**
 * User API
 */

/**
 * Terminate the call.
 * @param {Object} [options]
 */
RTCSession.prototype.terminate = function(options) {
  options = options || {};

  var cancel_reason,
    status_code = options.status_code,
    reason_phrase = options.reason_phrase,
    extraHeaders = options.extraHeaders || [],
    body = options.body;

  // Check Session Status
  if (this.status === C.STATUS_TERMINATED) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  switch(this.status) {
    // - UAC -
    case C.STATUS_NULL:
    case C.STATUS_INVITE_SENT:
    case C.STATUS_1XX_RECEIVED:
      console.log(LOG_PREFIX +'canceling RTCSession');

      if (status_code && (status_code < 200 || status_code >= 700)) {
        throw new TypeError('Invalid status_code: '+ status_code);
      } else if (status_code) {
        reason_phrase = reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';
        cancel_reason = 'SIP ;cause=' + status_code + ' ;text="' + reason_phrase + '"';
      }

      // Check Session Status
      if (this.status === C.STATUS_NULL) {
        this.isCanceled = true;
        this.cancelReason = cancel_reason;
      } else if (this.status === C.STATUS_INVITE_SENT) {
        if(this.received_100) {
          this.request.cancel(cancel_reason);
        } else {
          this.isCanceled = true;
          this.cancelReason = cancel_reason;
        }
      } else if(this.status === C.STATUS_1XX_RECEIVED) {
        this.request.cancel(cancel_reason);
      }

      this.failed('local', null, JsSIP.C.causes.CANCELED);
      break;

      // - UAS -
    case C.STATUS_WAITING_FOR_ANSWER:
      console.log(LOG_PREFIX +'rejecting RTCSession');

      status_code = status_code || 480;

      if (status_code < 300 || status_code >= 700) {
        throw new TypeError('Invalid status_code: '+ status_code);
      }

      this.request.reply(status_code, reason_phrase, extraHeaders, body);
      this.failed('local', null, JsSIP.C.causes.REJECTED);
      break;
    case C.STATUS_WAITING_FOR_ACK:
      // TODO: fix this - RFC 3261 section 15:
      // "...the callee's UA MUST NOT send a BYE on a confirmed dialog
      // until it has received an ACK for its 2xx response or until the server
      // transaction times out."
    case C.STATUS_CONFIRMED:
      console.log(LOG_PREFIX +'terminating RTCSession');

      // Send Bye
      this.sendBye(options);
      this.ended('local', null, JsSIP.C.causes.BYE);
      break;
  }

  this.close();
};

/**
 * Answer the call.
 * @param {Object} [options]
 */
RTCSession.prototype.answer = function(options) {
  options = options || {};

  var
    self = this,
    request = this.request,
    extraHeaders = options.extraHeaders || [],
    mediaConstraints = options.mediaConstraints || {'audio':true, 'video':true},
    sdp = options.sdp,

    // User media succeeded
    userMediaSucceeded = function(stream) {
      self.rtcMediaHandler.addStream(
        stream,
        streamAdditionSucceeded,
        streamAdditionFailed
      );
    },

    // User media failed
    userMediaFailed = function() {
      request.reply(480);
      self.failed('local', null, JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS);
    },

    // rtcMediaHandler.addStream successfully added
    streamAdditionSucceeded = function() {
      self.rtcMediaHandler.createAnswer(
        answerCreationSucceeded,
        answerCreationFailed
      );
    },

    // rtcMediaHandler.addStream failed
    streamAdditionFailed = function() {
      if (self.status === C.STATUS_TERMINATED) {
        return;
      }

      self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
    },

    // rtcMediaHandler.createAnswer succeeded
    answerCreationSucceeded = function(body) {
      var
        // run for reply success callback
        replySucceeded = function() {
          var retransmissions = 1,
            timeout = JsSIP.Timers.T1;
          self.status = C.STATUS_WAITING_FOR_ACK;

          /**
           * RFC3261 13.3.1.4
           * Response retransmissions cannot be accomplished by transaction layer
           *  since it is destroyed when receiving the first 2xx answer
           */
          self.timers.invite2xxTimer = window.setTimeout(function invite2xxRetransmission() {
              if (self.status !== JsSIP.RTCSession.C.STATUS_WAITING_FOR_ACK) {
                return;
              }

              console.log(LOG_PREFIX +'Retransmitting 2xx:', retransmissions++);
              request.reply(200, null, ['Contact: '+ self.contact], body);

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

          /**
           * RFC3261 14.2
           * If a UAS generates a 2xx response and never receives an ACK,
           *  it SHOULD generate a BYE to terminate the dialog.
           */
          self.timers.ackTimer = window.setTimeout(function() {
              if(self.status === C.STATUS_WAITING_FOR_ACK) {
                console.log(LOG_PREFIX + 'no ACK received, terminating the call');
                window.clearTimeout(self.timers.invite2xxTimer);
                self.sendBye();
                self.ended('remote', null, JsSIP.C.causes.NO_ACK);
              }
            },
            JsSIP.Timers.TIMER_H
          );

          self.started('local');
        },

        // run for reply failure callback
        replyFailed = function() {
          self.failed('system', null, JsSIP.C.causes.CONNECTION_ERROR);
        };

      extraHeaders.push('Contact: ' + self.contact);
      extraHeaders.push('Allow: '+ JsSIP.Utils.getAllowedMethods(self.ua, true));

      request.reply(200, null, extraHeaders,
        body,
        replySucceeded,
        replyFailed
      );
    },

    // rtcMediaHandler.createAnsewr failed
    answerCreationFailed = function() {
      if (self.status === C.STATUS_TERMINATED) {
        return;
      }

      self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
    };


  // Check Session Direction and Status
  if (this.direction !== 'incoming') {
    throw new TypeError('Invalid method "answer" for an outgoing call');
  } else if (this.status !== C.STATUS_WAITING_FOR_ANSWER) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // An error on dialog creation will fire 'failed' event
  if(!this.createDialog(request, 'UAS')) {
    request.reply(500, 'Missing Contact header field');
    return;
  }

  window.clearTimeout(this.timers.userNoAnswerTimer);

  this.dialog.processSessionTimerHeaders(request);
  this.dialog.addSessionTimerResponseHeaders(extraHeaders);

  if (sdp) {
    // Use the application-provided SDP
    answerCreationSucceeded(sdp);
  } else {
    // Handle PeerConnection, SDP, etc internally
    this.rtcMediaHandler.getUserMedia(
      userMediaSucceeded,
      userMediaFailed,
      mediaConstraints
    );
  }
};

/**
 * Send a DTMF
 *
 * @param {String|Number} tones
 * @param {Object} [options]
 */
RTCSession.prototype.sendDTMF = function(tones, options) {
  var duration, interToneGap,
    position = 0,
    self = this;

  options = options || {};
  duration = options.duration || null;
  interToneGap = options.interToneGap || null;

  if (tones === undefined) {
    throw new TypeError('Not enough arguments');
  }

  // Check Session Status
  if (this.status !== C.STATUS_CONFIRMED && this.status !== C.STATUS_WAITING_FOR_ACK) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

  // Check tones
  if (!tones || (typeof tones !== 'string' && typeof tones !== 'number') || !tones.toString().match(/^[0-9A-D#*]+$/i)) {
    throw new TypeError('Invalid tones: '+ tones);
  }

  tones = tones.toString();

  // Check duration
  if (duration && !JsSIP.Utils.isDecimal(duration)) {
    throw new TypeError('Invalid tone duration: '+ duration);
  } else if (!duration) {
    duration = DTMF.C.DEFAULT_DURATION;
  } else if (duration < DTMF.C.MIN_DURATION) {
    console.warn(LOG_PREFIX +'"duration" value is lower than the minimum allowed, setting it to '+ DTMF.C.MIN_DURATION+ ' milliseconds');
    duration = DTMF.C.MIN_DURATION;
  } else if (duration > DTMF.C.MAX_DURATION) {
    console.warn(LOG_PREFIX +'"duration" value is greater than the maximum allowed, setting it to '+ DTMF.C.MAX_DURATION +' milliseconds');
    duration = DTMF.C.MAX_DURATION;
  } else {
    duration = Math.abs(duration);
  }
  options.duration = duration;

  // Check interToneGap
  if (interToneGap && !JsSIP.Utils.isDecimal(interToneGap)) {
    throw new TypeError('Invalid interToneGap: '+ interToneGap);
  } else if (!interToneGap) {
    interToneGap = DTMF.C.DEFAULT_INTER_TONE_GAP;
  } else if (interToneGap < DTMF.C.MIN_INTER_TONE_GAP) {
    console.warn(LOG_PREFIX +'"interToneGap" value is lower than the minimum allowed, setting it to '+ DTMF.C.MIN_INTER_TONE_GAP +' milliseconds');
    interToneGap = DTMF.C.MIN_INTER_TONE_GAP;
  } else {
    interToneGap = Math.abs(interToneGap);
  }

  if (this.tones) {
    // Tones are already queued, just add to the queue
    this.tones += tones;
    return;
  }

  // New set of tones to start sending
  this.tones = tones;

  var sendDTMF = function () {
    var tone, timeout,
      tones = self.tones;

    if (self.status === C.STATUS_TERMINATED || !tones || position >= tones.length) {
      // Stop sending DTMF
      self.tones = null;
      return;
    }

    tone = tones[position];
    position += 1;

    if (tone === ',') {
      timeout = 2000;
    } else {
      var dtmf = new DTMF(self);
      dtmf.on('failed', function(){self.tones = null;});
      dtmf.send(tone, options);
      timeout = duration + interToneGap;
    }

    // Set timeout for the next tone
    window.setTimeout(sendDTMF, timeout);
  };

  // Send the first tone
  sendDTMF();
};


/**
 * Send a reINVITE
 *
 * @param {Object} [options]
 */
RTCSession.prototype.sendReinvite = function(options) {
  var sdp;

  options = options || {};
  sdp = options.sdp;

  // TODO: could get offer from PeerConnection if JsSIP is handling media 

  // Check whether the last INVITE transaction has completed
  // See RFC 3261 section 14.1
  if (this.lastReinvite) {
    switch (this.lastReinvite.status) {
    case C.STATUS_CONFIRMED:
    case C.STATUS_CANCELED:
    case C.STATUS_TERMINATED:
      break;
    default:
      throw new JsSIP.Exceptions.InvalidStateError(this.lastReinvite.status);
    }
  }

  // TODO: check whether there is an outstanding offer/answer exchange (including UPDATE)

  var reinvite = new Reinvite(this);
  reinvite.send(sdp, options);

  this.lastReinvite = reinvite;
};


/**
 * Send an UPDATE
 *
 * @param {Object} [options]
 */
RTCSession.prototype.sendUpdate = function(options) {
  var sdp;

  options = options || {};
  sdp = options.sdp;

  if (sdp) {
    // TODO: check whether there is an outstanding offer/answer exchange
  }

  var update = new Update(this);
  update.send(options);
};

/**
 * Checks whether the provided method is present in the Allow header received
 * from the remote party.  If an Allow header has not been received, the
 * provided default is returned instead.
 * @param {String} method The SIP method to check.
 * @param {Boolean} defaultValue The value to return if no Allow header has
 * been received.
 * @returns {Boolean}
 */
RTCSession.prototype.isMethodAllowed = function(method, defaultValue) {
  if (!this.allowed) {
    return defaultValue;
  }
  if (this.allowed.indexOf(method) >= 0) {
    return true;
  }
  return false;
};


/**
 * RTCPeerconnection handlers
 */
RTCSession.prototype.getLocalStreams = function() {
  return this.rtcMediaHandler &&
    this.rtcMediaHandler.peerConnection &&
    this.rtcMediaHandler.peerConnection.getLocalStreams() || [];
};

RTCSession.prototype.getRemoteStreams = function() {
  return this.rtcMediaHandler &&
    this.rtcMediaHandler.peerConnection &&
    this.rtcMediaHandler.peerConnection.getRemoteStreams() || [];
};


/**
 * Session Management
 */

/**
* @private
*/
RTCSession.prototype.init_incoming = function(request) {
  var expires,
    self = this,
    contentType = request.getHeader('Content-Type');

  // Check body and content type
  if(!request.body || (contentType !== 'application/sdp')) {
    request.reply(415);
    return;
  }

  // Session parameter initialization
  this.status = C.STATUS_INVITE_RECEIVED;
  this.from_tag = request.from_tag;
  this.id = request.call_id + this.from_tag;
  this.request = request;
  this.contact = this.ua.contact.toString();

  //Save the session into the ua sessions collection.
  this.ua.sessions[this.id] = this;

  // Store the allowed methods if provided
  if(request.hasHeader('allow')) {
    this.allowed = request.parseHeader('allow').methods;
  }

  //Get the Expires header value if exists
  if(request.hasHeader('expires')) {
    expires = request.getHeader('expires') * 1000;
  }

  /* Set the to_tag before
   * replying a response code that will create a dialog.
   */
  request.to_tag = JsSIP.Utils.newTag();

  // An error on dialog creation will fire 'failed' event
  if(!this.createDialog(request, 'UAS', true)) {
    request.reply(500, 'Missing Contact header field');
    return;
  }

  // Set up reply/media handling functions
  var sdpValid = function() {
    request.reply(180, null, ['Contact: ' + self.contact]);
    self.status = C.STATUS_WAITING_FOR_ANSWER;

    // Set userNoAnswerTimer
    self.timers.userNoAnswerTimer = window.setTimeout(function() {
        request.reply(480);
        self.failed('local',null, JsSIP.C.causes.NO_ANSWER);
      }, self.ua.configuration.no_answer_timeout
    );

    /* Set expiresTimer
     * RFC3261 13.3.1
     */
    if (expires) {
      self.timers.expiresTimer = window.setTimeout(function() {
          if(self.status === C.STATUS_WAITING_FOR_ANSWER) {
            request.reply(487);
            self.failed('system', null, JsSIP.C.causes.EXPIRES);
          }
        }, expires
      );
    }
  },
  
  sdpInvalid = function () {
    request.reply(488);
    self.failed('remote', request, JsSIP.C.causes.BAD_MEDIA_DESCRIPTION);
  },
  
  handleMedia = function() {
    self.rtcMediaHandler = new RTCMediaHandler(self);
    self.rtcMediaHandler.onMessage(
      'offer',
      request.body,
      /*
       * onSuccess
       * SDP Offer is valid. Fire UA newRTCSession
       */
      function() {
        sdpValid();
        self.newRTCSession('remote', request);
      },
      /*
       * onFailure
       * Bad media description
       */
      function(e) {
        console.warn(LOG_PREFIX +'invalid SDP');
        console.warn(e);
        sdpInvalid();
      }
    );
  };

  if (this.ua.configuration.handle_media) {
    //Initialize Media Session
    handleMedia();
  } else {
    /* Just notify the application of the new session.  It is responsible for
     * processing the SDP, and must call sdpValid() or sdpInvalid() as
     * appropriate.
     */
    this.newRTCSession('remote', request, sdpValid, sdpInvalid, handleMedia);
  }
};

/**
 * @private
 */
RTCSession.prototype.connect = function(target, options) {
  options = options || {};

  var event, requestParams, request,
    invalidTarget = false,
    eventHandlers = options.eventHandlers || {},
    extraHeaders = options.extraHeaders || [],
    mediaConstraints = options.mediaConstraints || {audio: true, video: true},
    RTCConstraints = options.RTCConstraints || {},
    featureTags = options.featureTags || '',
    sdp = options.sdp;

  if (target === undefined) {
    throw new TypeError('Not enough arguments');
  }

  // Check Session Status
  if (this.status !== C.STATUS_NULL) {
    throw new JsSIP.Exceptions.InvalidStateError(this.status);
  }

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

  // Session parameter initialization
  this.from_tag = JsSIP.Utils.newTag();
  if (!sdp) {
    this.rtcMediaHandler = new RTCMediaHandler(this, RTCConstraints);
  }

  // Set anonymous property
  this.anonymous = options.anonymous;

  // OutgoingSession specific parameters
  this.isCanceled = false;
  this.received_100 = false;

  requestParams = {
      from_tag: this.from_tag,
      extra_extensions: JsSIP.Utils.getSessionExtensions(this, JsSIP.C.INVITE)
  };

  this.contact = this.ua.contact.toString({
    anonymous: this.anonymous,
    outbound: true
  }) + featureTags;

  if (this.anonymous) {
    requestParams.from_display_name = 'Anonymous';
    requestParams.from_uri = 'sip:anonymous@anonymous.invalid';

    extraHeaders.push('P-Preferred-Identity: '+ this.ua.configuration.uri.toString());
    extraHeaders.push('Privacy: id');
  }

  request = new JsSIP.OutgoingRequest(JsSIP.C.INVITE, target, this.ua, requestParams, extraHeaders);
  this.request = request;
  request.setHeader('contact', this.contact);
  request.setHeader('allow', JsSIP.Utils.getAllowedMethods(this.ua, true));
  request.setHeader('content-type', 'application/sdp');

  this.id = this.request.call_id + this.from_tag;

  //Save the session into the ua sessions collection.
  this.ua.sessions[this.id] = this;

  this.newRTCSession('local', this.request);

  if (invalidTarget) {
    this.failed('local', null, JsSIP.C.causes.INVALID_TARGET);
  } else {
    if (sdp) {
      // Send the request now
      var request_sender = new JsSIP.RequestSender(this, this.ua);
      
      this.request.body = sdp;
      this.status = C.STATUS_INVITE_SENT;
      
      request_sender.send();
    } else {
      // Jump through some extra hoops to get media, SDP, etc
      this.sendInitialRequest(mediaConstraints);
    }
  }
};

/**
* @private
*/
RTCSession.prototype.close = function() {
  var idx;

  if(this.status === C.STATUS_TERMINATED) {
    return;
  }

  console.log(LOG_PREFIX +'closing INVITE session ' + this.id);

  // 1st Step. Terminate media.
  if (this.rtcMediaHandler){
    this.rtcMediaHandler.close();
  }

  // 2nd Step. Terminate signaling.

  // Clear session timers
  for(idx in this.timers) {
    window.clearTimeout(this.timers[idx]);
  }

  // Terminate dialogs

  // Terminate confirmed dialog
  if(this.dialog) {
    this.dialog.terminate();
    delete this.dialog;
  }

  // Terminate early dialogs
  for(idx in this.earlyDialogs) {
    this.earlyDialogs[idx].terminate();
    delete this.earlyDialogs[idx];
  }

  this.status = C.STATUS_TERMINATED;

  delete this.ua.sessions[this.id];
};

/**
 * Dialog Management
 * @private
 */
RTCSession.prototype.calcDialogId = function(message, type) {
  var local_tag = (type === 'UAS') ? message.to_tag : message.from_tag,
    remote_tag = (type === 'UAS') ? message.from_tag : message.to_tag;
    return message.call_id + local_tag + remote_tag;
};

/**
 * Dialog Management
 * @private
 */
RTCSession.prototype.createDialog = function(message, type, early) {
  var dialog, early_dialog,
    id = this.calcDialogId(message, type);

    early_dialog = this.earlyDialogs[id];

  // Early Dialog
  if (early) {
    if (early_dialog) {
      return true;
    } else {
      early_dialog = new JsSIP.Dialog(this, message, type, JsSIP.Dialog.C.STATUS_EARLY);

      // Dialog has been successfully created.
      if(early_dialog.id) {
        this.earlyDialogs[id] = early_dialog;
        return true;
      }
      // Dialog not created due to an error.
      else {
        this.failed('remote', message, JsSIP.C.causes.INTERNAL_ERROR);
        return false;
      }
    }
  }

  // Confirmed Dialog
  else {
    // In case the dialog is in _early_ state, update it
    if (early_dialog) {
      early_dialog.update(message, type);
      this.dialog = early_dialog;
      delete this.earlyDialogs[id];
      return true;
    }

    // Otherwise, create a _confirmed_ dialog
    dialog = new JsSIP.Dialog(this, message, type);

    if(dialog.id) {
      this.to_tag = message.to_tag;
      this.dialog = dialog;
      return true;
    }
    // Dialog not created due to an error
    else {
      this.failed('remote', message, JsSIP.C.causes.INTERNAL_ERROR);
      return false;
    }
  }
};


/**
 * In dialog Request Reception
 * @private
 * @returns true if the request is accepted, false otherwise
 */
RTCSession.prototype.receiveRequest = function(request) {
  var contentType;

  if(request.method === JsSIP.C.CANCEL) {
    /* RFC3261 15 States that a UAS may have accepted an invitation while a CANCEL
    * was in progress and that the UAC MAY continue with the session established by
    * any 2xx response, or MAY terminate with BYE. JsSIP does continue with the
    * established session. So the CANCEL is processed only if the session is not yet
    * established.
    */

    if(this.status === C.STATUS_WAITING_FOR_ANSWER) {
      // No response sent yet - terminate the session
      this.status = C.STATUS_CANCELED;
      // Reply 487 to the INVITE
      this.request.reply(487);
      // Reply 200 to the CANCEL
      request.reply(200);
      this.failed('remote', request, JsSIP.C.causes.CANCELED);
      return true;
    }

    // Reply 481 to the CANCEL
    request.reply(481);
    return false;
  }

  // Requests arriving here are in-dialog requests.
  switch(request.method) {
    case JsSIP.C.ACK:
      if(this.status === C.STATUS_WAITING_FOR_ACK) {
        window.clearTimeout(this.timers.ackTimer);
        window.clearTimeout(this.timers.invite2xxTimer);
        this.status = C.STATUS_CONFIRMED;
      } else if(this.lastReinvite &&
          this.lastReinvite.status === C.STATUS_WAITING_FOR_ACK) {
        this.lastReinvite.receiveAck();
      }
      break;
    case JsSIP.C.BYE:
      if(this.status === C.STATUS_CONFIRMED) {
        request.reply(200);
        this.ended('remote', request, JsSIP.C.causes.BYE);
      }
      break;
    case JsSIP.C.INVITE:
      if(this.status !== C.STATUS_CONFIRMED) {
        request.reply(491);
        return false;
      }
      if (this.lastReinvite) {
        switch (this.lastReinvite.status) {
        case C.STATUS_CONFIRMED:
        case C.STATUS_CANCELED:
        case C.STATUS_TERMINATED:
          // Previous reinvite has completed
          break;
        default:
          request.reply(491);
          return false;
        }
      }
      var reinvite = new Reinvite(this);
      reinvite.init_incoming(request);
      this.lastReinvite = reinvite;
      break;
    case JsSIP.C.INFO:
      if(this.status === C.STATUS_CONFIRMED || this.status === C.STATUS_WAITING_FOR_ACK) {
        contentType = request.getHeader('content-type');
        if (contentType && (contentType.match(/^application\/dtmf-relay/i))) {
          new DTMF(this).init_incoming(request);
        }
      }
      break;
    case JsSIP.C.UPDATE:
      var update = new Update(this);
      return update.init_incoming(request);
  }

  return true;
};


/**
 * Initial Request Sender
 * @private
 */
RTCSession.prototype.sendInitialRequest = function(constraints) {
  var
  self = this,
 request_sender = new JsSIP.RequestSender(self, this.ua),

 // User media succeeded
 userMediaSucceeded = function(stream) {
   self.rtcMediaHandler.addStream(
     stream,
     streamAdditionSucceeded,
     streamAdditionFailed
   );
 },

 // User media failed
 userMediaFailed = function() {
   if (self.status === C.STATUS_TERMINATED) {
     return;
   }

   self.failed('local', null, JsSIP.C.causes.USER_DENIED_MEDIA_ACCESS);
 },

 // rtcMediaHandler.addStream successfully added
 streamAdditionSucceeded = function() {
   self.rtcMediaHandler.createOffer(
     offerCreationSucceeded,
     offerCreationFailed
   );
 },

 // rtcMediaHandler.addStream failed
 streamAdditionFailed = function() {
   if (self.status === C.STATUS_TERMINATED) {
     return;
   }

   self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
 },

 // rtcMediaHandler.createOffer succeeded
 offerCreationSucceeded = function(offer) {
   if (self.isCanceled || self.status === C.STATUS_TERMINATED) {
     return;
   }

   request_sender = new JsSIP.RequestSender(self, this.ua),
   self.request.body = offer;
   self.status = C.STATUS_INVITE_SENT;
   request_sender.send();
 },

 // rtcMediaHandler.createOffer failed
 offerCreationFailed = function() {
   if (self.status === C.STATUS_TERMINATED) {
     return;
   }

   self.failed('local', null, JsSIP.C.causes.WEBRTC_ERROR);
 };

 this.rtcMediaHandler.getUserMedia(
   userMediaSucceeded,
   userMediaFailed,
   constraints
 );
};

/**
 * Reception of Response for Initial Request
 * @private
 */
RTCSession.prototype.receiveResponse = function(response) {
  switch (response.method) {
  case JsSIP.C.INVITE:
    this.receiveInviteResponse(response);
    break;
  case JsSIP.C.BYE:
    // We don't care about the response
    break;
  default:
    console.warn(LOG_PREFIX + 'Unexpected response received:', response);
    break;
  }
};

/**
 * Reception of Response for Initial Request
 * @private
 */
RTCSession.prototype.receiveInviteResponse = function(response) {
  var cause,
    session = this;

  if(this.status !== C.STATUS_INVITE_SENT &&
      this.status !== C.STATUS_1XX_RECEIVED &&
      this.status !== C.STATUS_CONFIRMED) {
    console.warn(LOG_PREFIX +'Unexpected INVITE response:', response);
    return;
  }

  // Proceed to cancellation if the user requested.
  if(this.isCanceled) {
    if(response.status_code >= 100 && response.status_code < 200) {
      this.request.cancel(this.cancelReason);
    } else if(response.status_code >= 200 && response.status_code < 299) {
      this.acceptAndTerminate(response);
    }
    return;
  }

  switch(true) {
    case /^100$/.test(response.status_code):
      this.received_100 = true;
      break;
    case /^1[0-9]{2}$/.test(response.status_code):
      // Do nothing with 1xx responses without To tag.
      if(!response.to_tag) {
        console.warn(LOG_PREFIX +'1xx response received without to tag');
        break;
      }

      // Create Early Dialog if 1XX comes with contact
      if(response.hasHeader('contact')) {
        // An error on dialog creation will fire 'failed' event
        this.createDialog(response, 'UAC', true);
      }

      this.status = C.STATUS_1XX_RECEIVED;
      this.progress('remote', response);
      break;
    case /^2[0-9]{2}$/.test(response.status_code):
      if (this.status === C.STATUS_CONFIRMED) {
        // We already have a confirmed dialog
        var did = this.calcDialogId(response, 'UAC');
        if (did === this.dialog.id.toString()) {
          // Looks like a retransmission - resend ACK
          console.info(LOG_PREFIX +'Retransmitting ACK');
          this.sendACK();
        } else {
          // Looks like a fork - clear it down gracefully
          console.info(LOG_PREFIX +'Accepting and terminating fork, did:', did);
          this.acceptAndTerminate(response);
        }

        break;
      }
      this.status = C.STATUS_CONFIRMED;

      if(!response.body) {
        this.acceptAndTerminate(response, 400, 'Missing session description');
        this.failed('remote', response, JsSIP.C.causes.BAD_MEDIA_DESCRIPTION);
        break;
      }
      
      // An error on dialog creation will fire 'failed' event
      if (!this.createDialog(response, 'UAC')) {
        break;
      }

      this.sendACK();

      // Store the allowed methods if provided
      if(response.hasHeader('allow')) {
        this.allowed = response.parseHeader('allow').methods;
      }

      this.dialog.processSessionTimerHeaders(response);

      if (this.rtcMediaHandler) {
        // We're handling the SDP, media, peer connection, etc
        this.rtcMediaHandler.onMessage(
            'answer',
            response.body,
            /*
             * onSuccess
             * SDP Answer fits with Offer. Media will start
             */
            function() {
              session.started('remote', response);
            },
            /*
             * onFailure
             * SDP Answer does not fit the Offer. Accept the call and Terminate.
             */
            function(e) {
              console.warn(e);
              session.sendBye({
                status_code: 488,
                reason_phrase: 'Not Acceptable Here'
              });
              session.failed('remote', response, JsSIP.C.causes.BAD_MEDIA_DESCRIPTION);
            }
          );
      } else {
        // The application is responsible for handling the media.
        // It must close the session if the SDP is unacceptable.
        session.started('remote', response);
      }
      break;
    default:
      cause = JsSIP.Utils.sipErrorCause(response.status_code);
      this.failed('remote', response, cause);
  }
};


/**
* @private
*/
RTCSession.prototype.acceptAndTerminate = function(response, status_code, reason_phrase) {
  // Send ACK and BYE
  // This method may be used with early dialogs - cannot just use confirmed dialog!
  var did = this.calcDialogId(response, 'UAC');
  var dialog = null;
  if (!this.dialog) {
    // Might as well confirm this dialog
    if (this.createDialog(response, 'UAC')){
      dialog = this.dialog;
    }
  } else if (this.dialog && did === this.dialog.id.toString()) {
    // Not sure why we would be accepting and terminating the confirmed dialog...
    dialog = this.dialog;
  } else if (this.earlyDialogs[did]) {
    // Use the existing early dialog
    dialog = this.earlyDialogs[did];
  } else {
    // Unknown dialog - create an early one
    if (this.createDialog(response, 'UAC', true)) {
      dialog = this.earlyDialogs[did];
    }
  }

  // An error on dialog creation will fire 'failed' event
  if (dialog) {
    this.sendACK({
      dialog: dialog
    });
    this.sendBye({
      dialog: dialog,
      status_code: status_code,
      reason_phrase: reason_phrase
    });
  }
};

/**
* @private
*/
RTCSession.prototype.sendACK = function(options) {
  options = options || {};

  var dialog = options.dialog || this.dialog, 
    request = dialog.createRequest(JsSIP.C.ACK);

  this.sendRequest(request);
};

/**
* @private
*/
RTCSession.prototype.sendBye = function(options) {
  options = options || {};

  var request, reason,
    status_code = options.status_code,
    reason_phrase = options.reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '',
    extraHeaders = options.extraHeaders || [],
    body = options.body,
    dialog = options.dialog || this.dialog;

  if (status_code && (status_code < 200 || status_code >= 700)) {
    throw new TypeError('Invalid status_code: '+ status_code);
  } else if (status_code) {
    reason = 'SIP ;cause=' + status_code + '; text="' + reason_phrase + '"';
    extraHeaders.push('Reason: '+ reason);
  }

  request = dialog.createRequest(JsSIP.C.BYE, extraHeaders);
  request.body = body;

  this.sendRequest(request);
};

/**
 * @private
 */
RTCSession.prototype.sendRequest = function(request) {
  var request_sender = new RequestSender(this, request);
  request_sender.send();
};

/**
 * Session Callbacks
 */

/**
* Callback to be called from UA instance when TransportError occurs
* @private
*/
RTCSession.prototype.onTransportError = function() {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('system', null, JsSIP.C.causes.CONNECTION_ERROR);
    } else {
      this.failed('system', null, JsSIP.C.causes.CONNECTION_ERROR);
    }
  }
};

/**
* Callback to be called from UA instance when RequestTimeout occurs
* @private
*/
RTCSession.prototype.onRequestTimeout = function() {
  if(this.status !== C.STATUS_TERMINATED) {
    if (this.status === C.STATUS_CONFIRMED) {
      this.ended('system', null, JsSIP.C.causes.REQUEST_TIMEOUT);
    } else {
      this.failed('system', null, JsSIP.C.causes.CONNECTION_ERROR);
    }
  }
};

/**
 * Internal Callbacks
 */

/**
 * @private
 */
RTCSession.prototype.newRTCSession = function(originator, request, sdpValid, sdpInvalid, handleMedia) {
  var session = this,
    event_name = 'newRTCSession';

  if (originator === 'remote') {
    session.direction = 'incoming';
    session.local_identity = request.to;
    session.remote_identity = request.from;
  } else if (originator === 'local'){
    session.direction = 'outgoing';
    session.local_identity = request.from;
    session.remote_identity = request.to;
  }

  session.ua.emit(event_name, session.ua, {
    originator: originator,
    session: session,
    request: request,
    sdpValid: sdpValid || null,
    sdpInvalid: sdpInvalid || null,
    handleMedia: handleMedia || null
  });
};

/**
 * @private
 */
RTCSession.prototype.connecting = function(originator, request) {
  var session = this,
  event_name = 'connecting';

  session.emit(event_name, session, {
    originator: 'local',
    request: request
  });
};

/**
 * @private
 */
RTCSession.prototype.progress = function(originator, response) {
  var session = this,
    event_name = 'progress';

  session.emit(event_name, session, {
    originator: originator,
    response: response || null
  });
};

/**
 * @private
 */
RTCSession.prototype.started = function(originator, message) {
  var session = this,
    event_name = 'started';

  session.start_time = new Date();

  session.emit(event_name, session, {
    originator: originator,
    response: message || null
  });
};

/**
 * @private
 */
RTCSession.prototype.ended = function(originator, message, cause) {
  var session = this,
    event_name = 'ended';

  session.end_time = new Date();

  session.close();
  session.emit(event_name, session, {
    originator: originator,
    message: message || null,
    cause: cause
  });
};

/**
 * @private
 */
RTCSession.prototype.failed = function(originator, message, cause) {
  var session = this,
    event_name = 'failed';

  session.close();
  session.emit(event_name, session, {
    originator: originator,
    message: message || null,
    cause: cause
  });
};


RTCSession.C = C;
JsSIP.RTCSession = RTCSession;
}(JsSIP));
