#!/usr/bin/with-contenv bashio
# waitress = single-process WSGI server with internal thread pool.
# Single process keeps RAM low on weak HA hosts (Pi 3 / 1GB class) while
# threads unblock the previous single-threaded Flask dev server.
exec waitress-serve --host=0.0.0.0 --port=2232 --threads=4 app:app
