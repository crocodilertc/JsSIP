/**
 * @fileoverview Refer
 */

/**
 * @param {JsSIP} JsSIP - The JsSIP namespace
 */
(function(JsSIP) {
  var Refer;

  /**
   * @class Class creating SIP REFER request.
   * @augments EventEmitter
   * @param {JsSIP.UA} ua
   */
  Refer = function(ua) {
    this.ua = ua;
    this.targetDialog = null;
    this.closed = false;
    this.request = null;
    this.local_tag = null;
    this.remote_tag = null;
    this.id = null;
    this.contact = null;
    this.accepted = false;
    this.rejected = false;

    // Public properties
    this.direction = null;
    this.local_identity = null;
    this.remote_identity = null;
    this.refer_uri = null;

    // Custom Refer empty object for high level use
    this.data = {};
  };
  Refer.prototype = new JsSIP.EventEmitter();

  Refer.prototype.send = function(target, refer_uri, options) {
    var request_sender, event, contentType, eventHandlers, extraHeaders, request,
      events = [
        'accepted',
        'succeeded',
        'failed'
      ],
      failCause = null;

    if (target === undefined || refer_uri === undefined) {
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
    this.contact = this.ua.contact.toString();

    request = new JsSIP.OutgoingRequest(JsSIP.C.REFER, target, this.ua,
        {from_tag: this.local_tag}, extraHeaders, options.body);
    this.request = request;
    this.id = request.call_id + request.from_tag;

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
        // Just close for now, but we should be receiving NOTIFYs on this dialog
        this.close();
        this.emit('accepted', this, {
          originator: 'remote',
          response: response
        });
        break;

      default:
        this.close();
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
  Refer.prototype.onRequestTimeout = function() {
    if(this.closed) {
      return;
    }
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
    this.close();
    this.emit('failed', this, {
      originator: 'system',
      cause: JsSIP.C.causes.CONNECTION_ERROR
    });
  };

  /**
  * @private
  */
  Refer.prototype.close = function() {
    // Terminate confirmed dialog
    if (this.dialog) {
      this.dialog.terminate();
      delete this.dialog;
    }

    this.closed = true;
    delete this.ua.refers[this];
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

    this.ua.emit('newRefer', this.ua, {
      originator: 'remote',
      refer: this,
      request: request,
      session: session
    });

    if (!this.accepted && !this.rejected) {
      var extraHeaders = ['Contact: ' + this.contact];
      request.reply(202, null, extraHeaders);
    }
  };

  /**
   * Accept the incoming Refer
   * Only valid for incoming Refers
   */
  Refer.prototype.accept = function(options) {
    options = options || {};

    var
      extraHeaders = options.extraHeaders || [],
      body = options.body;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "accept" for an outgoing refer');
    }

    extraHeaders.push('Contact: ' + this.contact);

    this.request.reply(200, null, extraHeaders, body);
    this.accepted = true;
  };

  /**
   * Reject the incoming Refer
   * Only valid for incoming Refers
   *
   * @param {Number} status_code
   * @param {String} [reason_phrase]
   */
  Refer.prototype.reject = function(options) {
    options = options || {};

    var
      status_code = options.status_code || 480,
      reason_phrase = options.reason_phrase,
      extraHeaders = options.extraHeaders || [],
      body = options.body;

    if (this.direction !== 'incoming') {
      throw new TypeError('Invalid method "reject" for an outgoing refer');
    }

    if (status_code < 300 || status_code >= 700) {
      throw new TypeError('Invalid status_code: '+ status_code);
    }

    this.request.reply(status_code, reason_phrase, extraHeaders, body);
    this.rejected = true;
  };

  /**
   * Receives further messages on the Refer dialog (i.e. NOTIFYs).
   * @private
   * @param {IncomingRequest} request
   */
  Refer.prototype.receiveRequest = function(request) {
    // TODO
    request.reply(200);
  };

  JsSIP.Refer = Refer;
}(JsSIP));
