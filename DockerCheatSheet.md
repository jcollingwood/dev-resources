# Docker Cheat Sheet: 

Docker Login:

```bash
> docker login -u jacollingwood --password-stdin
```

Show running containers:


```bash
> docker container ls
```

All containers:

```bash
> docker container ls -a
```

Show docker images:

```bash
> docker image ls
```

Build new image from Dockerfile:

```bash
> docker build -t REPO_NAME:TAG .{/path/to/dockerfile}
```

Run built image:

```bash
> docker run -p 3000:3000 -d --name CONTAINER_NAME REPO_NAME:TAG
```

Stop Container:

```bash
> docker stop CONTAINER_ID
```

Restart Container:

```bash
> docker restart CONTAINER_ID
```

Create docker network:

```bash
> docker network create network
```

Connect container to networks:

```bash
> docker network connect NETWORK CONTAINER_NAME
```

View docker networks:

```bash
> docker network ls
```

Push docker image to repo:

```bash
> docker push jacollingwood/REPO_NAME:TAG
```

Enter Container:

```bash
> docker exec -it CONTAINER_NAME 
```

Run Command in Container:

```bash
> docker exec -it CONTAINER_NAME [command]
```