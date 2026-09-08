-- MeetingBar -> smart plug bridge.
--
-- Installs to: ~/Library/Application Scripts/leits.MeetingBar/joinEventScript.scpt
-- (run mac/install-meeting-plug.sh, which compiles and places it for you).
--
-- MeetingBar v5 calls the `meetingStart` handler with the event's details --
-- including the real end date -- so the plug switches off when the meeting is
-- actually scheduled to end. MeetingBar 4.11.6 and earlier run the script with
-- no parameters at all; the `run` handler below catches that and sends no
-- duration, which makes the Pi fall back to its default meeting length.
--
-- Nothing here talks to the network directly: it shells out to
-- ~/.local/bin/meeting-plug-notify, because MeetingBar overwrites this file
-- whenever you edit the script in its Preferences window.

on plugHelperPath()
	return (POSIX path of (path to home folder)) & ".local/bin/meeting-plug-notify"
end plugHelperPath

-- minutesLeft of 0 or less means "length unknown".
on notifyPlug(eventTitle, minutesLeft)
	set helperPath to plugHelperPath()
	set safeTitle to eventTitle as string
	set cmd to quoted form of helperPath & " --minutes " & (minutesLeft as string) & ¬
		" --title " & quoted form of safeTitle & " > /dev/null 2>&1 &"
	-- Backgrounded and wrapped in a try: joining the call must never be blocked
	-- or aborted because a plug on the LAN didn't answer.
	try
		do shell script cmd
	end try
end notifyPlug

on onMeetingJoined(eventTitle, minutesLeft)
	-- The plug goes first: talking to Music can block on an automation
	-- permission prompt, and that must not delay switching the light on.
	notifyPlug(eventTitle, minutesLeft)
	-- Pause music, but only if it is already playing. An unconditional
	-- `tell application "Music" to pause` launches Music just to pause it.
	try
		if application "Music" is running then tell application "Music" to pause
	end try
end onMeetingJoined

-- MeetingBar v5+: the full 14-parameter event payload.
on meetingStart(eventID, eventTitle, isAllDay, startDate, endDate, eventLocation, isRecurrent, attendeeCount, meetingURL, meetingService, eventNotes, calendarName, calendarSource, attendeeList)
	-- All-day "events" are not meetings worth powering the plug for.
	if isAllDay then return
	set secondsLeft to (endDate - (current date))
	onMeetingJoined(eventTitle, secondsLeft div 60)
end meetingStart

-- MeetingBar 4.11.6 and earlier: no parameters, so no end date to work from.
on run
	onMeetingJoined("meeting", 0)
end run
