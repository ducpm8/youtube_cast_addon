ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.12-alpine3.19
FROM $BUILD_FROM
# ffmpeg dropped: app uses yt-dlp with download=False (extracts URLs only),
# never transcodes. Saves ~30MB image + ARM build time.
RUN apk add --no-cache python3 py3-pip
WORKDIR /app
RUN pip3 install --no-cache-dir flask requests yt-dlp apscheduler waitress --break-system-packages
COPY . .
RUN chmod a+x run.sh && sed -i 's/\r$//' run.sh
CMD [ "./run.sh" ]
