/**
 * @fileoverview Refer
 */

/**
 * @param {JsSIP} JsSIP - The JsSIP namespace
 */
(function(JsSIP) {
  var Refer,
    LOG_PREFIX = JsSIP.name +' | '+ 'REFER' +' | ',
    DEFAULT_EXPIRES = 3 * 60 * 1000;

  /**
   * @class Class representing an out-of-dialog SIP REFER request.
   * @augments EventEmitter
   * @param {JsSIP.UA} ua
   */
  Refer = function(ua) {
    var events = [
      'accepted',
      'failed',
      'notify'
    ];

    this.ua = ua;
    this.targetDialog = null;
    this.closed = false;
    this.request = null;
    this.local_tag = null;
    this.remote_tag = null;
    this.id = null;
    this.contact = null;
    this.notify_timer = null;
    this.dialog = null;
    this.subscription_state = 'pending';
    this.subscription_expires = null;
    this.expire_timer = null;
    this.last_notify_body = null;
    this.accepted = false;
    this.rejected = false;

    // Public properties
    this.direction = null;
    this.local_identity = null;
    this.remote_identity = null;
    this.refer_uri = null;

    // Custom Refer empty object for high level use
    this.data = {};

    this.initEvents(events);
  };
  Refer.prototype = new JsSIP.EventEmitter();

  Refer.prototype.send = function(target, refer_uri, options) {
    var request_sender, event, contentType, eventHandlers, extraHeaders, request,
      failCause = null;

    if (target === undefined || refer_uri === undefined) {
      throw new TypeError('Not enough arguments');
    }

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
      failCause = JsSIP.C.causes.INVALID_TARGET;
    }

    // Check refer-to validity
    try {
      refer_uri = JsSIP.Utils.normalizeURI(refer_uri, this.ua.configuration.hostport_params);
    } catch(e) {
      refer_uri = JsSIP.URI.parse(JsSIP.C.INVALID_TARGET_URI);
      failCause = JsSIP.C.causes.INVALID_REFER_TO_TARGET;
    }

    // Refer parameter initialization
    this.direction = 'outgoing';
    this.local_identity = this.ua.configuration.uri;
    this.remote_identity = target;
    this.refer_uri = refer_uri;
    this.local_tag = JsSIP.Utils.newTag();
    this.contact = this.ua.contact.toString({outbound: true});

    request = new JsSIP.OutgoingRequest(JsSIP.C.REFER, target, this.ua,
        {from_tag: this.local_tag}, extraHeaders, options.body);
    this.request = request;
    this.id = request.call_id + this.local_tag;

    this.ua.refers[this.id] = this;

    request.setHeader('contact', this.contact);
    request.setHeader('refer-to', refer_uri);

    if (options.targetDialog) {
      this.targetDialog = options.targetDialog;
      request.setHeader('require', JsSIP.C.SIP_EXTENSIONS.TARGET_DIALOG);
      request.setHeader('target-dialog', options.targetDialog.id.toTargetDialogHeader());
    }

    if(options.body) {
      request.setHeader('content-type', contentType);
    }

    request_sender = new JsSIP.RequestSender(this, this.ua);

    this.ua.emit('newRefer', this.ua, {
      originator: 'local',
      refer: this,
      request: this.request
    });

    if (failCause) {
      this.emit('failed', this, {
        originator: 'local',
        cause: failCause
      });
    } else {
      request_sender.send();
      console.log(LOG_PREFIX + this.id + ' sent');
      this.notify_timer = setTimeout(
          this.onNotifyTimeout.bind(this),
          JsSIP.Timers.TIMER_F);
    }
  };

  /**
  * @private
  */
  Refer.prototype.receiveResponse = function(response) {
    var cause;

    if(this.closed) {
      return;
    }
    switch(true) {
      case /^1[0-9]{2}$/.test(response.status_code):
        // Ignore provisional responses.
        break;

      case /^2[0-9]{2}$/.test(response.status_code):
        // The initial NOTIFY creates the dialog, not the 2xx response
        console.log(LOG_PREFIX + this.id + ' accepted');
        this.emit('accepted', this, {
          originator: 'remote',
          response: response
        });
        break;

      default:
        console.log(LOG_PREFIX + this.id + ' rejected (early)');
        this.close();
        cause = JsSIP.Utils.sipErrorCause(response.status_code);
        this.emit('failed', this, {
          originator: 'remote',
          message: response,
          cause: cause
        });
        break;
    }
  };

  /**
   * @private
   */
  Refer.prototype.onRequestTimeout = function() {
    if(this.closed) {
      return;
    }
    console.log(LOG_PREFIX + this.id + ' request timeout');
    this.close();
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.REQUEST_TIMEOUT
    });
  };

  /**
   * @private
   */
  Refer.prototype.onTransportError = function() {
    if(this.closed) {
      return;
    }
    console.log(LOG_PREFIX + this.id + ' transport error');
    this.close();
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.CONNECTION_ERROR
    });
  };

  /**
   * @private
   */
  Refer.prototype.onNotifyTimeout = function() {
    if (this.closed || this.subscription_state !== 'pending') {
      return;
    }
    console.log(LOG_PREFIX + this.id + ' notify timeout');
    this.emitFinalNotify();
    this.close();
  };

  /**
   * Re-emit the last notify, or a 100 Trying if we never received one.
   * @private
   */
  Refer.prototype.emitFinalNotify = function() {
    var sessionEvent,
      parsed = this.last_notify_body;

    if (!parsed) {
      parsed = JsSIP.Parser.parseMessage('SIP/2.0 100 Trying\r\n', true);
    }
  
    if (parsed.status_code < 200) {
      sessionEvent = 'progress';
    } else if (parsed.status_code < 300) {
      sessionEvent = 'started';
    } else {
      sessionEvent = 'failed';
    }
  
    this.emit('notify', this, {
      originator: 'system',
      request: null,
      sipFrag: parsed,
      sessionEvent: sessionEvent,
      finalNotify: true
    });
  };

  /**
   * @private
   */
  Refer.prototype.close = function() {
    if (this.subscription_state === 'active') {
      console.warn(LOG_PREFIX + this.id + ' closed with active subscription');

      if (this.direction === 'incoming') {
        // Send a NOTIFY that terminates the subscription
        this.notify({
          body: this.last_notify_body,
          finalNotify: true
        });
      } else {
        this.emitFinalNotify();
      }
    }

    if (this.expire_timer !== null) {
      clearTimeout(this.expire_timer);
      this.expire_timer = null;
    }

    if (this.notify_timer !== null) {
      clearTimeout(this.notify_timer);
      this.notify_timer = null;
    }

    // Terminate confirmed dialog
    if (this.dialog) {
      this.dialog.terminate();
      delete this.dialog;
    }

    this.closed = true;
    delete this.ua.refers[this];
    console.log(LOG_PREFIX + this.id + ' closed');
  };

  /**
   * @private
   */
  Refer.prototype.subscriptionExpired = function() {
    if (this.subscription_state === 'terminated') {
      return;
    }

    this.notify({
      body: this.last_notify_body,
      finalNotify: true,
      terminateReason: 'timeout'
    });
    // Don't close the refer in case they re-subscribe as a result of this notify
    this.expire_timer = null;
    console.log(LOG_PREFIX + this.id + ' subscription expired');
  };

  /**
   * @private
   * @param {IncomingRequest} request
   */
  Refer.prototype.init_incoming = function(request) {
    var session = null;

    this.direction = 'incoming';
    this.request = request;
    this.remote_tag = request.from_tag;
    this.id = request.call_id + request.from_tag;
    this.contact = this.ua.contact.toString();
    this.local_identity = request.to.uri;
    this.remote_identity = request.from.uri;

    // Check Refer-To header
    if (!request.hasHeader('refer-to')) {
      request.reply(400, 'Missing Refer-To header field');
      return;
    }
    if (request.countHeader('refer-to') > 1) {
      request.reply(400, 'Too many Refer-To header fields');
      return;
    }
    this.refer_uri = request.parseHeader('refer-to').uri;

    // Process Target-Dialog header (if present)
    if (request.hasHeader('target-dialog')) {
      var td = request.parseHeader('target-dialog');
      // Local/remote labels should be from recipient's perspective
      var did = new JsSIP.DialogId(td.call_id, td.local_tag, td.remote_tag);
      this.targetDialog = this.ua.dialogs[did.toString()] || null;
    }

    if (this.targetDialog && this.targetDialog.isConfirmed()) {
      session = this.targetDialog.owner;
      // Sanity check
      if (session.dialog !== this.targetDialog ||
          !session instanceof JsSIP.RTCSession) {
        session = null;
      }
    }

    // Set the to_tag before replying with a response code that will create a dialog.
    this.local_tag = request.to_tag = JsSIP.Utils.newTag();
    this.dialog = new JsSIP.Dialog(this, request, 'UAS');
    if(!this.dialog.id) {
      request.reply(500, 'Missing Contact header field');
      return;
    }

    this.ua.refers[this.id] = this;

    console.log(LOG_PREFIX + this.id + ' received');
    this.ua.emit('newRefer', this.ua, {
      originator: 'remote',
      refer: this,
      request: request,
      session: session
    });

    if (!this.accepted && !this.rejected) {
      this.accept();
    }
  };

  /**
   * Call the refer URI. The referrer will be notified of the progress and
   * result of the call establishment process.
   *
   * @param {Object} [options]
   * Call options as used with the <code>UA.call</code> method.
   * @returns {JsSIP.RTCSession}
   *
   * @throws {TypeError}
   * @throws {JsSIP.Exceptions.InvalidTargetError}
   */
  Refer.prototype.call = function(options) {
    var session,
      uri = this.refer_uri;

    if (uri.scheme !== JsSIP.C.SIP) {
      throw new JsSIP.Exceptions.InvalidTargetError(uri);
    }

    if (!this.accepted) {
      this.accept();
    }

    session = new JsSIP.RTCSession(this.ua);
    session.connect(uri, options);
    this.addSessionNotifyHandlers(session);

    return session;
  };

  /**
   * Adds handlers to the provided session to send appropriate NOTIFY
   * messages to the referrer.
   * @param {JsSIP.RTCSession} session
   */
  Refer.prototype.addSessionNotifyHandlers = function(session) {
    var self = this;

    session.on('progress', function(event) {
      var response = event.data.response;
      self.notify({
        status_code: response.status_code,
        reason_phrase: response.reason_phrase
      });
    });

    session.once('started', function(event) {
      var response = event.data.response;
      self.notify({
        status_code: response.status_code,
        reason_phrase: response.reason_phrase
      });
      self.close();
    });

    session.once('failed', function(event) {
      var status_code = 500,
        reason_phrase = null,
        message = event.data.message;

      if (message && message instanceof JsSIP.IncomingResponse) {
        status_code = message.status_code;
        reason_phrase = message.reason_phrase;
      }

      self.notify({
        status_code: status_code,
        reason_phrase: reason_phrase
      });
      self.close();
    });
  };

  /**
   * Accept the incoming Refer. Use this for non-SIP refer URIs; for SIP URIs
   * use the <code>call</code> method instead.
   * <p>
   * After calling this method, the application should call the
   * <code>notify</code> method to inform the referrer of the progress/result
   * of the refer. This is handled automatically if the <code>call</code>
   * method is used instead.
   * 
   * @param {Object} [options]
   * @param {String[]} [options.extraHeaders]
   * Extra headers to add to the response.
   * @param {String} [options.body]
   * A message body to include in the response.
   */
  Refer.prototype.accept = function(options) {
    options = options || {};

    var
      extraHeaders = options.extraHeaders || [],
      body = options.body;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "accept" for an outgoing refer');
    }

    if (this.closed) {
      return;
    }

    // Set the subscription state and expiry
    this.subscription_state = 'active';
    this.subscription_expires = Date.now() + DEFAULT_EXPIRES;
    this.expire_timer = setTimeout(this.subscriptionExpired.bind(this),
        DEFAULT_EXPIRES);

    extraHeaders.push('Contact: ' + this.contact);

    this.request.reply(202, null, extraHeaders, body);
    // Send initial notify
    this.notify();
    this.accepted = true;
    console.log(LOG_PREFIX + this.id + ' accepted');
  };

  /**
   * Reject the incoming Refer.
   *
   * @param {Object} [options]
   * @param {Number} [options.status_code]
   * @param {String} [options.reason_phrase]
   * @param {String[]} [options.extraHeaders]
   * @param {String} [options.body]
   */
  Refer.prototype.reject = function(options) {
    options = options || {};

    var
      status_code = options.status_code || 603,
      reason_phrase = options.reason_phrase,
      extraHeaders = options.extraHeaders || [],
      body = options.body;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "reject" for an outgoing refer');
    }

    if (status_code < 300 || status_code >= 700) {
      throw new TypeError('Invalid status_code: '+ status_code);
    }

    if (this.closed) {
      return;
    }

    if (this.accepted) {
      // Delayed reject (required user input)
      console.log(LOG_PREFIX + this.id + ' rejected (late)');
      this.notify({
        status_code: status_code,
        reason_phrase: reason_phrase
      });
    } else {
      // Immediate reject (policy)
      console.log(LOG_PREFIX + this.id + ' rejected (early)');
      this.request.reply(status_code, reason_phrase, extraHeaders, body);
      this.rejected = true;
    }

    this.close();
  };

  /**
   * Notify the referrer of the current refer progress, or final result.
   * <p>
   * The application should either provide a SIP status code, or a message body
   * of type <code>message/sipfrag</code>. If neither is provided, a
   * <code>100 Trying</code> message will be constructed. If a message body is
   * provided, the <code>finalNotify</code> flag should also be set to indicate
   * whether this is the final NOTIFY message.
   *
   * @param {Object} [options]
   * @param {Number} [options.status_code]
   * @param {String} [options.reason_phrase]
   * @param {String} [options.body]
   * @param {Boolean} [options.finalNotify]
   * @param {String} [options.terminateReason]
   * @param {String[]} [options.extraHeaders]
   */
  Refer.prototype.notify = function(options) {
    var status_code, reason_phrase, finalNotify, newState, reason, stateHeader,
      body, notify,
      self = this;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "notify" for an outgoing refer');
    }

    options = options || {};
    if (options.body && typeof options.finalNotify === 'undefined') {
      throw new TypeError('Must specify finalNotify when providing notify body');
    }

    if (this.subscription_state !== 'active') {
      // Ignore
      return;
    }

    status_code = options.status_code || 100;
    reason_phrase = options.reason_phrase || JsSIP.C.REASON_PHRASE[status_code] || '';
    finalNotify = options.finalNotify || status_code >= 200;

    if (finalNotify) {
      newState = 'terminated';
      reason = options.terminateReason || 'noresource';
      stateHeader = newState + ';reason=' + reason;
    } else {
      newState = 'active';
      stateHeader = newState + ';expires=' +
          Math.round((this.subscription_expires - Date.now()) / 1000);
    }

    body = options.body || 'SIP/2.0 ' + status_code + ' ' + reason_phrase + '\r\n';
    this.last_notify_body = body;

    notify = new JsSIP.Notify(this);
    notify.send('refer', stateHeader, {
      extraHeaders: options.extraHeaders,
      eventHandlers: options.eventHandlers,
      content_type: 'message/sipfrag',
      body: body
    });

    this.subscription_state = newState;
    if (!finalNotify) {
      // If the notify fails, terminate the subscription
      notify.on('failed', function(){
        self.subscription_state = 'terminated';
        console.log(LOG_PREFIX + self.id + ' unsubscribed (rejected notify)');
        self.close();
      });
    }
  };

  /**
   * Receives further messages on the Refer dialog (i.e. NOTIFYs for outgoing
   * refers, and possibly SUBSCRIBEs for incoming refers).
   * @private
   * @param {IncomingRequest} request
   */
  Refer.prototype.receiveRequest = function(request) {
    switch (request.method) {
    case JsSIP.C.NOTIFY:
      this.receiveNotify(request);
      return;
    case JsSIP.C.SUBSCRIBE:
      this.receiveSubscribe(request);
      return;
    }

    request.reply(405, null, ['Allow: '+ JsSIP.Utils.getAllowedMethods(this.ua)]);
  };

  /**
   * Receives NOTIFY messages on the Refer dialog.
   * @private
   * @param {IncomingRequest} request
   */
  Refer.prototype.receiveNotify = function(request) {
    var eventHeader, stateHeader, typeHeader, parsed, sessionEvent,
      extraHeaders, sipfrag,
      finalNotify = false;

    if (this.direction !== 'outgoing' ||
        (this.subscription_state !== 'active' &&
            this.subscription_state !== 'pending')) {
      request.reply(481, 'Subscription Does Not Exist');
      return;
    }

    eventHeader = request.parseHeader('event');
    if (!eventHeader || eventHeader.event !== 'refer') {
      request.reply(489);
      this.close();
      return;
    }

    stateHeader = request.parseHeader('subscription-state');
    if (!stateHeader) {
      request.reply(400, 'Missing Subscription-State Header');
      this.close();
      return;
    }

    typeHeader = request.getHeader('content-type');
    if (typeHeader && typeHeader.indexOf('message/sipfrag') < 0) {
      request.reply(415);
      this.close();
      return;
    }

    sipfrag = request.body;
    if (!/\r\n$/.test(sipfrag)) {
      // Strictly this is an invalid sipfrag, but fudge it by appending the
      // expected end-line characters.
      sipfrag += '\r\n';
    }

    parsed = JsSIP.Parser.parseMessage(sipfrag, true);
    if (!parsed || !parsed instanceof JsSIP.IncomingResponse) {
      request.reply(400, 'Bad Message Body');
      this.close();
      return;
    }

    if (this.listeners('notify').length === 0) {
      console.log(LOG_PREFIX + this.id + ' no notify listeners; unsubscribing');
      request.reply(603);
      this.subscription_state = 'terminated';
      this.close();
      return;
    }

    if (!this.dialog) {
      // Form a dialog based on this request
      this.remote_tag = request.from_tag;
      this.dialog = new JsSIP.Dialog(this, request, 'UAS');

      if (!this.dialog.id) {
        // Probably missing the Contact header
        console.warn(LOG_PREFIX + this.id + ' dialog creation failed');
        this.close();

        this.emit('failed', this, {
          originator: 'remote',
          message: request,
          cause: JsSIP.C.causes.INTERNAL_ERROR
        });
        return;
      }
    }

    this.subscription_state = stateHeader.state;
    this.subscription_expires = Date.now() + stateHeader.expires * 1000;
    this.last_notify_body = parsed;
    if (this.notify_timer !== null) {
      clearTimeout(this.notify_timer);
      this.notify_timer = null;
    }
    if (this.expire_timer !== null) {
      clearTimeout(this.expire_timer);
      this.expire_timer = null;
    }

    extraHeaders = ['Contact: ' + this.contact];
    request.reply(200, null, extraHeaders);

    if (parsed.status_code < 200) {
      sessionEvent = 'progress';
    } else if (parsed.status_code < 300) {
      sessionEvent = 'started';
    } else {
      sessionEvent = 'failed';
    }

    console.log(LOG_PREFIX + this.id + ' notify: ' + sessionEvent);

    if (this.subscription_state === 'terminated') {
      finalNotify = true;
      this.close();
    } else {
      this.expire_timer = setTimeout(this.close.bind(this),
          (stateHeader.expires + JsSIP.Timers.T4) * 1000);
    }

    this.emit('notify', this, {
      originator: 'remote',
      request: request,
      sipFrag: parsed,
      sessionEvent: sessionEvent,
      finalNotify: finalNotify
    });
  };

  /**
   * Receives SUBSCRIBE messages on the Refer dialog.
   * @private
   * @param {IncomingRequest} request
   */
  Refer.prototype.receiveSubscribe = function(request) {
    var eventHeader, expires, extraHeaders;

    if (this.direction !== 'incoming') {
      request.reply(481);
      return;
    }

    if (this.subscription_state !== 'active' &&
        this.subscription_state !== 'terminated') {
      request.reply(403);
      return;
    }

    eventHeader = request.parseHeader('event');
    if (!eventHeader || eventHeader.event !== 'refer') {
      request.reply(489);
      return;
    }

    expires = request.parseHeader('expires');
    if (expires === 0) {
      console.log(LOG_PREFIX + this.id + ' unsubscribed (expires=0)');
      // Remote party is unsubscribing, send a final notify
      this.notify({
        body: this.last_notify_body,
        finalNotify: true
      });
      extraHeaders = [
        'Contact: ' + this.contact
      ];
      request.reply(200, null, extraHeaders);
      this.close();
      return;
    }

    if (expires > 0) {
      expires = expires * 1000;
    } else {
      expires = DEFAULT_EXPIRES;
    }

    this.subscription_state = 'active';
    this.subscription_expires = Date.now() + expires;
    if (this.expire_timer !== null) {
      clearTimeout(this.expire_timer);
    }
    this.expire_timer = setTimeout(this.subscriptionExpired.bind(this), expires);

    extraHeaders = [
      'Contact: ' + this.contact,
      'Expires: ' + expires / 1000
    ];
    request.reply(200, null, extraHeaders);
    console.log(LOG_PREFIX + this.id + ' subscription extended');
  };

  JsSIP.Refer = Refer;
}(JsSIP));
