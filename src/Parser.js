/**
 * @fileoverview SIP Message Parser
 */

/**
 * Extract and parse every header of a SIP message.
 * @augments JsSIP
 * @namespace
 */
(function(JsSIP) {
var Parser,
  LOG_PREFIX = JsSIP.name +' | '+ 'PARSER' +' | ';

function getHeader(data, headerStart) {
  var
    // 'start' position of the header.
    start = headerStart,
    // 'end' position of the header.
    end = 0,
    // 'partial end' position of the header.
    partialEnd = 0;

  //End of message.
  if (data.substring(start, start + 2).match(/(^\r\n)/)) {
    return -2;
  }

  while(end === 0) {
    // Partial End of Header.
    partialEnd = data.indexOf('\r\n', start);

    // 'indexOf' returns -1 if the value to be found never occurs.
    if (partialEnd === -1) {
      return partialEnd;
    }

    if(!data.substring(partialEnd + 2, partialEnd + 4).match(/(^\r\n)/) && data.charAt(partialEnd + 2).match(/(^\s+)/)) {
      // Not the end of the message. Continue from the next position.
      start = partialEnd + 2;
    } else {
      end = partialEnd;
    }
  }

  return end;
}

function parseHeader(message, data, headerStart, headerEnd) {
  var header, idx, parsed,
    hcolonIndex = data.indexOf(':', headerStart),
    headerName = data.substring(headerStart, hcolonIndex).trim(),
    headerValue = data.substring(hcolonIndex + 1, headerEnd).trim();

  // If header-field is well-known, parse it.
  switch(headerName.toLowerCase()) {
    case 'via':
    case 'v':
      message.addHeader('via', headerValue);
      if(message.countHeader('via') === 1) {
        parsed = message.parseHeader('Via');
        if(parsed) {
          message.via = parsed;
          message.via_branch = parsed.branch;
        }
      } else {
        parsed = 0;
      }
      break;
    case 'from':
    case 'f':
      message.setHeader('from', headerValue);
      parsed = message.parseHeader('from');
      if(parsed) {
        message.from = parsed;
        message.from_tag = parsed.getParam('tag');
      }
      break;
    case 'to':
    case 't':
      message.setHeader('to', headerValue);
      parsed = message.parseHeader('to');
      if(parsed) {
        message.to = parsed;
        message.to_tag = parsed.getParam('tag');
      }
      break;
    case 'record-route':
      parsed = JsSIP.Grammar.parse(headerValue, 'Record_Route');

      if (parsed === -1) {
        parsed = undefined;
      }

      for(idx in parsed) {
        header = parsed[idx];
        message.addHeader('record-route', headerValue.substring(header.possition, header.offset));
        message.headers['Record-Route'][message.countHeader('record-route')-1].parsed = header.parsed;
      }
      break;
    case 'call-id':
    case 'i':
      message.setHeader('call-id', headerValue);
      parsed = message.parseHeader('call-id');
      if(parsed) {
        message.call_id = headerValue;
      }
      break;
    case 'contact':
    case 'm':
      parsed = JsSIP.Grammar.parse(headerValue, 'Contact');

      if (parsed === -1) {
        parsed = undefined;
      }

      for(idx in parsed) {
        header = parsed[idx];
        message.addHeader('contact', headerValue.substring(header.possition, header.offset));
        message.headers['Contact'][message.countHeader('contact')-1].parsed = header.parsed;
      }
      break;
    case 'content-length':
    case 'l':
      message.setHeader('content-length', headerValue);
      parsed = message.parseHeader('content-length');
      break;
    case 'content-type':
    case 'c':
      message.setHeader('content-type', headerValue);
      parsed = message.parseHeader('content-type');
      break;
    case 'cseq':
      message.setHeader('cseq', headerValue);
      parsed = message.parseHeader('cseq');
      if(parsed) {
        message.cseq = parsed.value;
      }
      if(message instanceof JsSIP.IncomingResponse) {
        message.method = parsed.method;
      }
      break;
    case 'max-forwards':
      message.setHeader('max-forwards', headerValue);
      parsed = message.parseHeader('max-forwards');
      break;
    case 'www-authenticate':
      message.setHeader('www-authenticate', headerValue);
      parsed = message.parseHeader('www-authenticate');
      break;
    case 'proxy-authenticate':
      message.setHeader('proxy-authenticate', headerValue);
      parsed = message.parseHeader('proxy-authenticate');
      break;
    case 'session-expires':
    case 'x':
      message.setHeader('session-expires', headerValue);
      parsed = message.parseHeader('session-expires');
      break;
    case 'min-se':
      message.setHeader('min-se', headerValue);
      parsed = message.parseHeader('min-se');
      break;
    case 'supported':
    case 'k':
      message.setHeader('supported', headerValue);
      parsed = message.parseHeader('supported');
      break;
    case 'require':
      message.setHeader('require', headerValue);
      parsed = message.parseHeader('require');
      break;
    case 'allow':
      message.setHeader('allow', headerValue);
      parsed = message.parseHeader('allow');
      break;
    case 'refer-to':
    case 'r':
      message.setHeader('refer-to', headerValue);
      parsed = message.parseHeader('refer-to');
      break;
    case 'target-dialog':
      message.setHeader('target-dialog', headerValue);
      parsed = message.parseHeader('target-dialog');
      break;
    case 'event':
    case 'o':
      message.setHeader('event', headerValue);
      parsed = message.parseHeader('event');
      break;
    case 'subscription-state':
      message.setHeader('subscription-state', headerValue);
      parsed = message.parseHeader('subscription-state');
      break;
    default:
      // Do not parse this header.
      message.setHeader(headerName, headerValue);
      parsed = 0;
  }

  if (parsed === undefined) {
    return false;
  } else {
    return true;
  }
}

/** Parse SIP Message
 * @function
 * @param {String} message SIP message.
 * @param {Boolean} Indicates a SIP fragment message (RFC 3420).
 * @returns {JsSIP.IncomingRequest|JsSIP.IncomingResponse|undefined}
 */
Parser = {};
Parser.parseMessage = function(data, sipfrag) {
  var message, firstLine, contentLength, bodyStart, parsed,
    headerStart = 0,
    headerEnd = data.indexOf('\r\n');

  if(headerEnd === -1) {
    console.warn(LOG_PREFIX +'no CRLF found, not a SIP message, discarded');
    return;
  }

  // Parse first line. Check if it is a Request or a Reply.
  firstLine = data.substring(0, headerEnd);
  parsed = JsSIP.Grammar.parse(firstLine, 'Request_Response');

  if(parsed === -1) {
    console.warn(LOG_PREFIX +'error parsing first line of SIP message: "' + firstLine + '"');
    return;
  } else if(!parsed.status_code) {
    message = new JsSIP.IncomingRequest();
    message.method = parsed.method;
    message.ruri = parsed.uri;
  } else {
    message = new JsSIP.IncomingResponse();
    message.status_code = parsed.status_code;
    message.reason_phrase = parsed.reason_phrase;
  }

  message.data = data;
  headerStart = headerEnd + 2;

  /* Loop over every line in data. Detect the end of each header and parse
  * it or simply add to the headers collection.
  */
  while(headerStart < data.length) {
    headerEnd = getHeader(data, headerStart);

    // The SIP message has normally finished.
    if(headerEnd === -2) {
      bodyStart = headerStart + 2;
      break;
    }
    // data.indexOf returned -1 due to a malformed message.
    else if(headerEnd === -1) {
      if (sipfrag) {
        // Allowed to not end headers with an empty line, if there is no body
        break;
      } else {
        // Malformed message
        console.warn(LOG_PREFIX +'error parsing message: no empty line terminating headers');
        return;
      }
    }

    parsed = parseHeader(message, data, headerStart, headerEnd);

    if(!parsed) {
      console.warn(LOG_PREFIX +'error parsing header: "' + data.substring(headerStart, headerEnd) + '"');
      return;
    }

    headerStart = headerEnd + 2;
  }

  if (bodyStart) {
    /* RFC3261 18.3.
     * If there are additional bytes in the transport packet
     * beyond the end of the body, they MUST be discarded.
     */
    if(message.hasHeader('content-length')) {
      contentLength = message.getHeader('content-length');
      message.body = data.substr(bodyStart, contentLength);
    } else {
      message.body = data.substring(bodyStart);
    }
  }

  return message;
};

JsSIP.Parser = Parser;
}(JsSIP));
