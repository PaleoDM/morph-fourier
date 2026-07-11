-- Morph-Fourier launcher (macOS).
-- Starts the local server with NO visible terminal, opens the browser, and
-- stays in the Dock so that quitting the app (Cmd-Q or right-click > Quit)
-- stops the server. setup.command compiles this into "Morph-Fourier.app".

on run
	set myPosix to POSIX path of (path to me)
	set repoDir to do shell script "cd " & quoted form of myPosix & "/.. && pwd"
	set venvPy to repoDir & "/backend/.venv/bin/python"
	set distIndex to repoDir & "/frontend/dist/index.html"
	set ready to (do shell script "if [ -x " & quoted form of venvPy & " ] && [ -f " & quoted form of distIndex & " ]; then echo yes; else echo no; fi")
	if ready is "no" then
		display dialog "Morph-Fourier needs a one-time setup first (a few minutes). A Terminal window will open to install it — when it says “Setup complete”, reopen Morph-Fourier." buttons {"Install now"} default button "Install now" with title "Morph-Fourier"
		do shell script "open -a Terminal " & quoted form of (repoDir & "/setup.command")
		return
	end if
	-- Detach the server (nohup + &) so no Terminal window ever appears; the
	-- launcher opens the browser itself once the server is up.
	do shell script "cd " & quoted form of repoDir & " && nohup ./run-prod.command > /tmp/morph-fourier.log 2>&1 &"
end run

on idle
	return 3600
end idle

on quit
	do shell script "pkill -f 'uvicorn app.main:app' > /dev/null 2>&1 || true"
	continue quit
end quit
