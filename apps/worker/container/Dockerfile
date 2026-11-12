FROM debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392 AS cleaned
# All packages are downloaded and hash checked by build.ts against the frozen snapshot.
# No package repository or secret is available during this offline install.
COPY packages/ /tmp/fortipi-packages/
RUN dpkg -i /tmp/fortipi-packages/*.deb && dpkg --purge apt sqv && rm -rf /tmp/fortipi-packages && mkdir -p /workspace && ln -s GFDL-1.3 /usr/share/common-licenses/GFDL-3
COPY computerd /usr/local/bin/computerd
COPY notices/ /usr/share/doc/fortipi-computerd/
FROM scratch
COPY --from=cleaned / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=auto
USER 0:0
WORKDIR /
SHELL ["/bin/sh", "-c"]
EXPOSE 8080/tcp
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/computerd"]
CMD []
