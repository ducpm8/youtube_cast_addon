ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.12-alpine3.19
FROM $BUILD_FROM
RUN apk add --no-cache python3 py3-pip ffmpeg
WORKDIR /app
RUN pip3 install --no-cache-dir flask requests yt-dlp apscheduler --break-system-packages
COPY . .
RUN chmod a+x run.sh && sed -i 's/\r$//' run.sh
CMD [ "./run.sh" ]
