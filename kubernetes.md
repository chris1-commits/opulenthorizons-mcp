# Kubernetes (K8s)

Kubernetes (also known as K8s) is an open-source platform designed to manage containerized applications in different environments, such as cloud, on-premises, or hybrid setups. It acts as an orchestration tool for automating the deployment, scaling, and operation of application containers.

## Key Features of Kubernetes

1. **Automated Deployment and Scaling**:
   Kubernetes streamlines the deployment of your application containers and automatically scales them based on demand.

2. **Load Balancing**:
   It offers built-in load balancing to distribute traffic across containers, ensuring that no container is overwhelmed.

3. **Self-Healing**:
   If a container fails or becomes unresponsive, Kubernetes automatically restarts or replaces it to maintain a healthy application state.

4. **Service Discovery**:
   Kubernetes assigns a DNS name or a unique IP address to containers, enabling smooth communication between components.

5. **Storage Orchestration**:
   It can mount and manage storage from local disks, cloud providers, or enterprise storage systems.

6. **Infrastructure Abstraction**:
   Kubernetes allows you to run your applications consistently across different hardware and cloud environments.

## Core Concepts

- **Cluster**: A Kubernetes cluster is a group of machines running Kubernetes components, typically consisting of:
  - **Control Plane (Master Nodes)**: Oversees and manages the cluster.
  - **Worker Nodes**: Hosts and manages the application containers.

- **Pods**: The smallest deployable unit in Kubernetes, which can contain one or more closely related containers.

- **ReplicaSets**: Maintains a desired number of identical replicas (copies) of a specific pod.

- **Deployments**: Declarative updates to pods and ReplicaSets, providing version control for your application.

- **Services**: Provide stable endpoints and enable communication between different components of your application or external clients.

## Why Use Kubernetes?

Kubernetes is particularly useful when managing microservices or when building complex applications requiring high availability and fault-tolerance. It's widely adopted in the DevOps world because it reduces operational complexity.

## Is Kubernetes Paid?

No, **Kubernetes itself is not paid**—it is an **open-source project** managed by the Cloud Native Computing Foundation (CNCF). You can use Kubernetes for free by setting up your own infrastructure (e.g., on local machines, data centers, or cloud platforms).

However, the cost comes with the infrastructure you'll need to run Kubernetes. For example:
- If you use a **cloud provider** like AWS, GCP, or Azure to run your Kubernetes cluster, you'll have to pay them for the compute, storage, and networking resources you consume.
- Managed Kubernetes services (like **Google Kubernetes Engine (GKE)**, **Amazon EKS**, or **Azure AKS**) charge additional fees for managing the Kubernetes control plane, though some providers offer free control plane tiers.

To summarize: **Kubernetes is open-source and free, but infrastructure or managed Kubernetes services may cost money based on your use.**

## Is Kubernetes in Docker?

Kubernetes and Docker work together, but they serve different purposes. Here's how they relate:

- **Docker**:
  Docker is a tool for creating, packaging, and running containerized applications. It defines the "images" and runs containers locally or on other runtimes.

- **Kubernetes**:
  Kubernetes is an **orchestration platform** for managing those containers at scale. While Docker allows you to build and run containers, Kubernetes helps you efficiently deploy, monitor, scale, and maintain those containers in a cluster (a group of machines).

Kubernetes **can manage Docker containers, but Docker itself is not required**. Kubernetes supports many container runtimes as of today. Some of the common options include:
- **containerd** (used by default in modern Kubernetes versions)
- **CRI-O**
- Docker (via a component called "dockershim", though it was removed in Kubernetes v1.24)

### Summary of Kubernetes and Docker Relationship

- Docker packages your application into containers.
- Kubernetes manages and orchestrates containerized applications at scale.
- Initially, Kubernetes relied on Docker, but it has since become runtime-agnostic with support for other runtimes like **containerd**.
