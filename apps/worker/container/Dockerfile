FROM ghcr.io/cloudflare/computer-computerd-linux-x64@sha256:6ec793fa80f109acf8b3cd4e295284cfed97f61c03030b780a612ec22c49b294 AS computerd
FROM debian@sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392
# All packages are downloaded and hash checked by build.ts against the frozen snapshot.
# No package repository or secret is available during this offline install.
COPY packages/ /tmp/fortipi-packages/
RUN dpkg -i /tmp/fortipi-packages/*.deb && rm -rf /tmp/fortipi-packages && mkdir -p /workspace
COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY notices/ /usr/share/doc/fortipi-computerd/
ENV PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=auto
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
