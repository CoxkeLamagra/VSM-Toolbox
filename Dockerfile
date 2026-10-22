FROM python:3.13-slim-trixie
WORKDIR /app
COPY app.py ./
COPY web ./web
RUN chmod -R a+rX /app && useradd --system --uid 10001 --create-home vsm && mkdir /data && chown vsm:vsm /data
USER vsm
ENV VSM_HOST=0.0.0.0 VSM_PORT=8080 VSM_DATABASE=/data/vsm.sqlite3
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health')"
CMD ["python", "app.py"]
