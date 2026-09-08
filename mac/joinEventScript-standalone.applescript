-- MeetingBar -> SmartThings plug, standalone.
--
-- Paste this straight into MeetingBar > Preferences > Advanced > "Edit script",
-- then Save. Nothing else to install -- unlike mac/joinEventScript.applescript
-- it talks to the Pi directly instead of going through
-- ~/.local/bin/meeting-plug-notify, which makes it the right choice on a
-- machine where you can't drop files into ~/.local/bin.
--
-- The trade-off: the token lives in this script, so if you re-edit it in
-- MeetingBar's window keep the plugToken line intact.
--
-- Set these three, then paste.

property plugURL : "http://pi.local:8787"
property plugURLFallback : "http://192.168.1.104:8787"
property plugToken : "PASTE_YOUR_MEETING_PLUG_TOKEN_HERE"

-- MeetingBar v5+ hands the join hook the full event, so the plug switches off
-- when the meeting was actually scheduled to end. On 4.11.6 and earlier the
-- script is run with no parameters at all, which lands in the implicit run
-- handler further down, and the Pi falls back to its default meeting length.
on meetingStart(eventID, eventTitle, isAllDay, startDate, endDate, eventLocation, isRecurrent, attendeeCount, meetingURL, meetingService, eventNotes, calendarName, calendarSource, attendeeList)
	if isAllDay then return
	notifyPlug(eventTitle, ((endDate - (current date)) div 60))
end meetingStart

-- MeetingBar 4.11.6 and earlier run the script with no parameters at all, which
-- lands here, in the implicit run handler.
--
-- Deliberately a bare top-level line rather than an `on run` handler: pasting
-- into MeetingBar's editor without clearing it first leaves the old script's
-- top-level commands above this, and AppleScript refuses to compile top-level
-- commands alongside an explicit `on run` ("The run handler is specified more
-- than once", -2752). This form simply runs after whatever was left behind.
notifyPlug("meeting", 0)

-- minutesLeft of 0 or less means "length unknown": the duration is left out and
-- the Pi uses MEETING_PLUG_DEFAULT_MINUTES.
on notifyPlug(eventTitle, minutesLeft)
	set jsonBody to "{\"title\":\"" & jsonEscape(eventTitle as string) & "\""
	if minutesLeft > 0 then set jsonBody to jsonBody & ",\"minutes\":" & (minutesLeft as string)
	set jsonBody to jsonBody & "}"

	set authHeader to "Authorization: Bearer " & plugToken
	set primary to curlFor(plugURL, authHeader, jsonBody)
	set backup to curlFor(plugURLFallback, authHeader, jsonBody)

	-- Backgrounded, short timeouts, errors swallowed: off the home LAN nothing
	-- here is reachable, and joining the actual call must never wait on a light.
	try
		do shell script "{ " & primary & " || " & backup & " ; } > /dev/null 2>&1 &"
	end try
end notifyPlug

on curlFor(baseURL, authHeader, jsonBody)
	return "curl -fsS --connect-timeout 3 --max-time 6 -X POST " & ¬
		quoted form of (baseURL & "/meeting/start") & ¬
		" -H " & quoted form of authHeader & ¬
		" -H 'Content-Type: application/json' -d " & quoted form of jsonBody
end curlFor

on jsonEscape(t)
	set t to replaceText(t, "\\", "\\\\")
	set t to replaceText(t, "\"", "\\\"")
	-- Control characters are not legal in a JSON string; a pasted meeting title
	-- routinely contains newlines and tabs.
	set t to replaceText(t, return, " ")
	set t to replaceText(t, linefeed, " ")
	set t to replaceText(t, tab, " ")
	return t
end jsonEscape

on replaceText(theText, searchStr, replaceStr)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to searchStr
	set parts to text items of theText
	set AppleScript's text item delimiters to replaceStr
	set out to parts as string
	set AppleScript's text item delimiters to oldDelims
	return out
end replaceText
